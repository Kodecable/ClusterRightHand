# Distribution and setup

How crhs and crha are packaged, and how `crhs init` and `crha enroll` set up a host. Self-update is not
designed yet; the packaging leaves room for it.

## Artifacts

| Artifact | Contents | Self-update |
|---|---|---|
| crhs OCI image | Node, the bundle, the WebUI and re2 | No; pull a new image |
| crhs tar without Node | The bundle, the WebUI and a `package.json` naming re2; the user runs `npm ci --omit=dev` | No |
| crhs tar with Node | The above plus Node and re2's binary, and an install script | Planned |
| crha tar | The static binary and an install script | Planned |
| crha deb and rpm | The static binary, built with the `pkgmanaged` tag | Never; the package manager updates it |

`pnpm build:crhs` produces the common part in `dist/crhs`: esbuild bundles the server and every pure
JavaScript dependency into `crhs.mjs`. Only native modules stay outside: `re2` is shipped with its runtime
files, and `cpu-features` is optional for `ssh2`, which falls back to JavaScript and WebAssembly. The
version is injected at build time; an unbundled crhs reports `dev`.

## Answering questions

`crhs init` and `crha enroll` ask their questions on the terminal. Each question has a default, except
those that cannot have one (a server address, a token, a password).

The only way to answer ahead is an answers file, `--answers <file>`: one JSON object with a `version` and
the fields below. There are no flags per question, so new questions never grow the command line. Unknown
fields and wrong types are errors. A question the file answers is not asked; with standard input not a
terminal, a missing answer is an error that names the field, never a prompt that waits.

Secrets (passwords, tokens, database URLs) are typed at the prompt or read from an answers file that only
its owner can read; otherwise the file is refused. `--save-answers <file>` writes the answers of an
interactive run without its secrets, to repeat the setup elsewhere.

An interactive run shows a summary and asks for confirmation before changing anything. A run answered
entirely by the file does not ask.

## crhs init

Run as root on a host install. It asks:

| Question | Default | Field |
|---|---|---|
| Listen address and port | `127.0.0.1`, `8080` | `listen.host`, `listen.port` |
| Database | SQLite | `database.driver` |
| SQLite file | `/var/lib/crhs/crhs.db` | `database.path` |
| PostgreSQL URL (tested at once) | — | `database.url` (secret) |
| Public URL (may stay empty) | empty | `public_url` |
| Administrator username, display name, password | `admin` | `admin.username`, `admin.display_name`, `admin.password` (secret) |
| Install and start the systemd service | yes | `service.install`, `service.start` |

It then creates the `crhs` system user, `/etc/crhs` (root:crhs, 0750) and `/var/lib/crhs` (crhs, 0700);
writes `crhs.toml` (root:crhs, 0640) without `web_root`, so the bundled WebUI is used; creates the master
key, migrates the database, creates the administrator and stores the public URL as a system setting;
installs `crhs.service`, whose `ExecStart` names the running Node and `crhs.mjs`; and finally reminds the
operator to back up the master key, take a key export and set up a reverse proxy with TLS. The paths are
fixed; a different layout is a manual install.

Every step is skipped when it is already done (the file, key, administrator or unit exists), so an
interrupted init is simply run again.

In the OCI image everything lives in `/crhs-data`: the configuration, the master key, the SQLite
database and the answers file, so one volume holds all state and is the unit of backup. The image sets
`CRHS_DATA_DIR=/crhs-data`, which makes init put every file there instead of the fixed host paths. When
`/crhs-data/crhs.toml` is missing, the entrypoint runs `crhs init --answers /crhs-data/init.json` with
`service.install` false; init then tells the operator to delete the file, which holds the administrator's
password. The image creates no system user and no unit.

## crha enroll

Run as root. It asks:

| Question | Default | Field |
|---|---|---|
| crhs address | — | `server` |
| Enrollment token | — | `token` (secret) |
| Check the TLS certificate against the system CAs (the token's fingerprint authenticates crhs either way) | yes | `tls_verify` |
| Re-enroll, keeping the node's id, name, groups and grants (asked first when already enrolled) | no | `replace` |
| Privileged mode: `ignore` or `forward` | `ignore` | `privileged.mode` |
| Let local root approve with `crha approve` (forward) | yes | `privileged.local_root` |
| Trust entries from the WebUI's **Generate trust config**, ending with a line `.`; empty to configure later (forward) | empty | `privileged.trust` |
| Start the services | yes | `service.start` |

`native` and `reject` are left to a manual `crha.toml`.

On an enrolled node, answering no to `replace` keeps the existing enrollment: the server, the TLS
setting and the privileged mode come from the existing `crha.toml`, no token is needed, the enrollment
step is skipped and every other step runs as usual (for `forward`, `privileged.toml` must already
exist).

It then creates the `crha` user and group when missing, `/etc/crha` (root:crha, 0750) and `/var/lib/crha`
(crha, 0700); writes `crha.toml` (root:crha, 0640); enrolls, writing the keys (owned by crha) only after
crhs accepted the token, as before; for `forward`, writes `privileged.toml` (root, 0600) with the
enrolled node id, crha's uid, the local root entry and the pasted entries, which are parsed first; writes
the units; enables them, starting them if asked; and prints the node id and key fingerprint to compare
when approving the node in the WebUI.

`crha register --config <file>` is the step underneath, for a manual layout and for tests: it reads
the token from standard input, uses the server and paths of an existing `crha.toml`, and only registers
the node (with `--replace` to re-enroll). It creates no user, file or unit. `crha enroll` calls the same
Go code rather than running `crha register`, so nothing passes through a command line twice.

The WebUI's New node and Re-enroll dialogs show `sudo crha enroll` with the address and the token to
paste, each with its own copy button, rather than one command line that would keep the token in the
shell history.

## Generated units

crha writes its units because the privileged mode decides which units exist: `crha.service` always (as
the crha user) and `crha-privileged.service` for `forward` (as root). crhs writes `crhs.service`. The
units go to `/etc/systemd/system/` and are owned by the program that wrote them:

```ini
# This file is managed by crha. DO NOT EDIT; customize with systemctl edit.
[Unit]
X-CRH-Managed=1
X-CRH-Meta={"v":1,"version":"0.1.0","mode":"forward","config":"/etc/crha/crha.toml"}
```

systemd ignores `X-` keys. A later version reads the metadata to migrate the unit and overwrites the file
without checking for edits; customizations belong in drop-ins. deb and rpm packages remove the units
carrying the marker when the package is removed.

# Command-line reference

This page describes what each command is for, with common examples. Run `crhs --help`,
`crha --help`, `crhu --help` or `<command> --help` for every flag.

## crhs

`crhs` runs on the server host ([Install](../install.md)); the examples use the `crhs` command installed by
the tar with Node. Every command except `init` reads the configuration file (`--config`, default
`/etc/crhs/crhs.toml`) and brings the database schema up to date before it runs.

| Command | Purpose |
|---|---|
| `serve` | Run the server. This is the default command. |
| `init [--answers <file>] [--save-answers <file>]` | Set up this host: user, directories, configuration, key, database, administrator and systemd unit. |
| `user add <username>` | Create a user; `--admin` makes an administrator. |
| `user passwd <username>` | Set a user's password and sign out their WebUI sessions. |
| `keys init` | Create the master key file for a new database. |
| `keys export --out <file>` | Write a passphrase-protected backup of crhs's keys. |
| `keys import <file>` | Restore the master key file from an export. |

```sh
crhs init
crhs init --answers /root/crhs-init.json --save-answers /root/crhs-init.without-secrets.json
crhs user add alice --admin --display-name "Alice Example"
printf '%s\n' "$PASSWORD" | crhs user add bob          # non-interactive
crhs keys export --out /root/crhs-keys.age
crhs keys import /root/crhs-keys.age
```

A username (from `user add` or `init`) is trimmed and lower-cased and must start with a letter, like
usernames created in the WebUI ([Concepts](../concepts.md#users-user-groups-and-administrators)).

`crhs init` asks its questions on the terminal, showing each default (Enter takes it), then prints a
summary and asks before changing anything. `--answers <file>` answers questions ahead with one JSON
object; `--save-answers <file>` writes an interactive run's answers without the secrets. Without a
terminal, every question must be answered by the file.

Passwords and passphrases are never taken as arguments. On a terminal they are prompted for twice;
otherwise one line is read from standard input.

`keys init` refuses to overwrite an existing key file and refuses a database that already belongs to
another key. `keys export` writes an [age](https://age-encryption.org/) file containing crhs's private
keys, so keep it offline; it is available only on the command line. `keys import` checks the export
against the restored database before writing the key file. See [Backups and restore](../operations.md#backups-and-restore).

Exit codes: 0 on success, 1 when the command is refused (for example a duplicate user or a wrong key
file), 2 when the command line or the configuration file is invalid.

## crha

`crha` runs on a node. `crha enroll` defaults to `/etc/crha/crha.toml`; the other commands that need a
configuration take `--config` and have no default path.

| Command | Purpose |
|---|---|
| `enroll [--config <path>] [--answers <file>] [--save-answers <file>]` | Set up and enroll this node; run as root. |
| `register --config <path> [--replace]` | Enroll using an existing `crha.toml`; the token is read from standard input. |
| `run` | Run the unprivileged mode, which connects to crhs and runs tasks. |
| `status` | Show the server URL, the node's key fingerprint and the privilege mode. |
| `version` | Show the version. |
| `upgrade status` | Print the last upgrade's outcome, what `upgrade rollback` would do now, and the upgrade log (`/var/lib/crha-upgrade/upgrade.jsonl`). |
| `upgrade rollback [--force]` | As root: undo the upgrade that produced the running version, or one interrupted after its backup, back to the lower release it came from, and restart crha; for when the new version cannot reach crhs. It refuses when a file changed since the upgrade wrote it, unless `--force`; run it again to step back through an older upgrade while its backup is kept. A package-managed `crha` refuses, because deb and rpm packages are not published for now. |

```sh
sudo crha enroll
sudo crha enroll --answers /root/crha-enroll.json --save-answers /root/crha-enroll.without-token.json
sudo crha enroll --config /etc/crha/crha.toml
printf '%s\n' "$TOKEN" | crha register --config /etc/crha/crha.toml
crha run --config /etc/crha/crha.toml
crha status --config /etc/crha/crha.toml
```

`crha enroll` sets up the node: it creates the `crha` user and group, `/etc/crha`, `/var/lib/crha`,
`crha.toml`, the enrolled keys, `privileged.toml` and `/var/lib/crha-privileged` for `forward` mode, and
the systemd units. It asks its
questions on the terminal, showing each default; `--answers <file>` answers them ahead with one JSON
object (a file holding the token must be readable only by its owner), and `--save-answers <file>` writes
an interactive run's answers without the token. Without a terminal every question must be answered by
the file. Each step that is already done is skipped, so an interrupted run can be repeated.

`crha enroll` checks crhs's identity against the fingerprint in the token and prints the node id and
key fingerprint. When the node already has a key it asks first whether to enroll again with a new key, and afterwards
says whether crhs kept the node (a Re-enroll token) or registered a new one (a New node token), for
which it updates `node_id` in `privileged.toml`. Answering no keeps the existing enrollment: the
server, TLS setting and privileged mode come from the existing `crha.toml`, no token is needed and the
enrollment step is skipped (for `forward`, `privileged.toml` must already exist). Enrolling again moves
`identity.key`, `server.pub` and `node_id` aside as `.old` files (overwriting older ones) and restores
them if enrollment fails. When anything changes it stops `crha-privileged` and `crha` first and starts
them again at the end, or after a failure.

`crha register` is the enrollment step alone, for a manual layout: it reads the token from standard
input (or prompts without echo on a terminal), uses the server and paths of an existing `crha.toml`,
and creates no user, file or unit. `--replace` re-enrolls an existing node. `crha enroll` calls the same
code rather than running `crha register`.

Errors are printed as `crha: <message>` with exit code 1.

## crha privileged

| Command | Purpose |
|---|---|
| `privileged run --config <file>` | Run the privileged mode of a `forward` node, usually as root. |
| `privileged check --config <file>` | Validate `privileged.toml` exactly as the privileged mode loads it, and print the trust digest a reload would produce. |
| `privileged stdio` | The helper that `native` mode starts through sudo, doas or run0. Not for direct use. |

`privileged run --no-persist-used` keeps the record of executed tasks in memory only, for devices with
limited flash endurance. After a restart, a one-shot authorization could then be used again until its
deadline.

## crhu

`crhu` is the standalone signing utility for your workstation. It signs authorization payloads from
the WebUI, builds and signs offline authorizations, and signs the challenge that registers an SSH
signing credential. It never reads a private key: it calls `ssh-keygen -Y sign`, so encrypted keys,
ssh-agent and FIDO keys work, and it verifies the result before printing it.

| Command | Purpose |
|---|---|
| `sign --payload <base64> [--spec <base64> \| --spec -] [--content <file>]… [--hint <SHA256:…>]… [--key <path>] [--key-dir <dir>]… [--yes]` | Sign the payload of a WebUI authorization request. |
| `grant --nodes <ids> --deadline <time> [--spec <base64> \| --spec - \| --method … --prefix … \| --any-command] [--task …] [--note …] [--hint …] [--key …]` | Build and sign a reusable or one-shot offline authorization. |
| `register <challenge> [--hint …] [--key …] [--key-dir …]` | Sign the challenge shown when registering an SSH signing credential. |
| `version` | Show the version. |

`--nodes` takes node or node group UUIDs (shown in the WebUI) or `*`, never names. Every
authorization needs `--deadline`, either a duration (`24h`) or an RFC 3339 time. Exactly one command
limit restricts it: `--spec` binds the complete task spec by its hash (the method is derived from the
spec), `--method` with `--prefix` binds a method and a target prefix, and `--any-command` leaves it
unrestricted. `--prefix ''` (given, but empty) allows every target of the method and is warned about;
leaving `--prefix` out is not the same. `--task` makes it one-shot. Paste the printed line into
**Issue authorization** on the WebUI's Authorizations page, or submit it through
`POST /api/authorizations`.

`--spec` is standard base64 of the canonical CBOR task spec, the encoding `spec_sha256` hashes; `--spec
-` reads it from standard input, for a spec too large for the argument list. `crhu sign` requires it
whenever the payload's command limit is a `spec` (the payload carries only the hash): it decodes the
spec, recomputes the hash and refuses a mismatch, then shows every field, the method and target the
node would match included. `--content` hashes a local file and matches it against the spec's input
(an exec `stdin`, a `file.write` content or a `file.push` transfer), refusing a mismatch, so the signer
checks the bytes as well as the spec. A prefix that does not end in `/` for a file method, or in a space
for `exec`, is warned about: it also matches longer targets.

```sh
# The payload and spec from the WebUI, with the hints the page shows
crhu sign --payload '<payload from the WebUI>' --spec '<spec from the WebUI>' --hint SHA256:…

# A spec too large for the argument list is read from standard input
crhu sign --payload '<payload>' --spec - <<'EOF'
<spec from the WebUI>
EOF

# A reusable authorization for a scheduled task
crhu grant --nodes 0192f000-0000-7000-8000-000000000001 \
  --method exec --prefix "systemctl restart " --deadline 720h --key ~/.ssh/id_ed25519

# Every exec task on one node for five minutes (the WebUI's "crhu 5min" tab)
crhu grant --nodes 0192f000-0000-7000-8000-000000000001 \
  --method exec --prefix '' --deadline 5m

# The same for one task, bound by its spec
crhu grant --nodes 0192f000-0000-7000-8000-000000000001 \
  --spec '<spec from the WebUI>' --deadline 720h --key ~/.ssh/id_ed25519

# The registration challenge from Signing credentials
crhu register '<challenge from the WebUI>'
```

Without `--key`, `crhu` looks for signing keys in this order: ssh-agent identities through
`SSH_AUTH_SOCK`, `~/.ssh/*.pub`, `~/.crhu/keys/*.pub`, each directory in `CRHU_KEY_DIRS` (separated
by `:`, like `PATH`), then each `--key-dir`. A missing `~/.ssh` or `~/.crhu/keys` is skipped; a
directory named in `CRHU_KEY_DIRS` or `--key-dir` must exist. Only `*.pub` files are read, never
subdirectories. `ssh-keygen` signs with the agent when it holds the key, else with the private key
at the same path without `.pub`. One candidate is used automatically; with
several, the fingerprints and comments are listed and you choose on the terminal. `--hint` selects
the first candidate whose fingerprint matches (the WebUI puts the credentials matching the plan's
entries in the copied command), and `--key` uses exactly that file. `--yes` skips the payload
confirmation; without it the exact bytes are shown and confirmed on `/dev/tty`. Only key types CRH
verifies are candidates (ed25519, ecdsa-sha2-nistp256 and their FIDO `sk-` variants); an RSA or
other key is skipped, and named in the error when nothing else is left. The passphrase of an
encrypted key, or a FIDO PIN, is asked on the terminal by `ssh-keygen`.

The signature is checked before anything is printed. The printed line is the base64 Authorization
that the WebUI accepts (`sign`, `grant`) or the SSHSIG that the registration form accepts
(`register`). Install `crhu` from its tar archive ([Install](../install.md#install-crhu)).

## crha approve and lock

The local approval window, for users listed in a `local` trust entry. These commands talk directly to
the privileged mode; crhs is not involved.

```sh
sudo crha approve                  # print the current window state
sudo crha approve --for 30m        # open or replace the window for 30 minutes
sudo crha lock                     # close the window early
```

While the window is open, a task authorized by crhs's own signature runs on the node without the
limits of its crhs trust entry, including its guard rules and `max_ttl`. crhs effectively holds the
privileged identity on the node, so open a window only when you mean that. The window closes on
expiry, on `crha lock`, or when the privileged mode restarts. The length must be positive and no
longer than `max_window` of the local entries that list your uid (one hour by default); the command
prints the window's end time. A node with no `crhs` entry cannot open a window.

`--for` takes a Go duration (`30m`, `2h`). They connect to `/run/crha/privileged.sock` unless
`--socket` or `CRHA_PRIVILEGED_SOCKET` names another socket.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `CRHA_TASK_HOME`, `CRHA_TASK_USER`, `CRHA_TASK_LOGNAME`, `CRHA_TASK_SHELL` | crha | Override the account and shell given to tasks ([crha configuration](crha-config.md#environment-overrides)). |
| `CRHA_PRIVILEGED_SOCKET` | `crha approve`, `crha lock` | The privileged mode's socket. |
| `UV_THREADPOOL_SIZE` | crhs | Node.js worker threads; raise it together with **System settings → Sign-in → Argon2 concurrency**. |
| `RE2_DOWNLOAD_MIRROR` | `npm ci` in the crhs tar without Node | Mirror for the prebuilt RE2 module. |

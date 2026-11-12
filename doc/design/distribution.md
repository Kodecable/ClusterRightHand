# Distribution and setup

How crhs and crha are packaged, and how `crhs init` and `crha enroll` set up a host. Self-update is not
designed yet; the packaging leaves room for it.

## Artifacts

`pnpm package` builds every archive into `dist/release/` and writes `SHA256SUMS`; downloads are cached in
`dist/cache/`. The version is `CRH_VERSION` or `git describe --tags --always --dirty`, the same as
`pnpm build:crhs`, which it runs first unless `--skip-build`; `--arch amd64,arm64` picks the
architectures (default both). `pnpm package:oci` stages one build context per architecture in
`dist/oci-context-<arch>/` (default the host's architecture) and prints the `podman build` commands.
Each context holds the contents of `dist/crhs` with that architecture's prebuilt `re2` binary in place
of the host build.

| Archive (top directory) | Contents | Self-update |
|---|---|---|
| `crhs-<v>.tar.gz` (`crhs-<v>/`) | `crhs.mjs`, `web/`, `package.json`, `package-lock.json`, `THIRD_PARTY_LICENSES.txt`, `VERSION`, `LICENSE`, `README.txt` | No |
| `crhs-<v>-linux-<arch>.tar.gz` (`crhs-<v>-linux-<arch>/`) | the bundle and WebUI, `node/` (the official `bin/node`), `node_modules/re2` for the arch, `bin/crhs`, `install.sh`, licenses, `VERSION` | Planned |
| `crha-<v>-linux-<arch>.tar.gz` (`crha-<v>-linux-<arch>/`) | the static `crha`, `install.sh`, `LICENSE`, `THIRD_PARTY_LICENSES.txt`, `VERSION` | Planned |
| crhs OCI image | Node, the bundle, the WebUI and re2 | No; pull a new image |
| `crha_<debversion>_<arch>.deb`, `crha-<rpmversion>-1.<rpmarch>.rpm` | `crha` in `/usr/bin` and the licenses in `/usr/share/doc/crha`, built with nfpm and the `pkgmanaged` tag | Never; the package manager updates it |

`arch` is `amd64` or `arm64`. Archives are deterministic-ish: entries sorted by name, the mtime of the
tree's last commit, owner 0:0, `gzip -n`. The archive without Node is installed by hand: run
`npm ci --omit=dev` once in the unpacked directory (it downloads or builds re2), then `node crhs.mjs init`
and `node crhs.mjs serve`.

`pnpm build:crhs` produces the common part in `dist/crhs`: esbuild bundles the server and every pure
JavaScript dependency into `crhs.mjs`. Only native modules stay outside: `re2` is shipped with its runtime
files, and `cpu-features` is optional for `ssh2`, which falls back to JavaScript and WebAssembly. The
version is injected at build time; an unbundled crhs reports `dev`. The archive with Node carries Node's
LICENSE appended to `THIRD_PARTY_LICENSES.txt`; the `crha` archive collects the Go modules' licenses.

### crha deb and rpm

`pnpm package` builds `crha_<debversion>_<arch>.deb` and `crha-<rpmversion>-1.<rpmarch>.rpm` with nfpm,
which must be on `PATH`; the `amd64`/`arm64` architectures become `x86_64`/`aarch64` in the rpm name. A
prerelease `1.2.0-rc.1` is packaged as `1.2.0~rc.1`, because dpkg and rpm sort `~` before the release
and a `-` after it. A version that does not start with a digit, such as a `git describe` result, is
packaged as `0.0.0~git<version>`, with `-` replaced by `.`. The packages contain only `/usr/bin/crha` (with the
`pkgmanaged` build tag) and `/usr/share/doc/crha/{LICENSE,THIRD_PARTY_LICENSES.txt}`; they create no
user, directory or unit, because `crha enroll` does that. `crha version` then prints `package-managed`,
and `crha upgrade` refuses in favour of apt or dnf.

The nfpm scripts in `packaging/nfpm/` are shared by deb and rpm. On an upgrade the postinstall script
restarts `crha-privileged.service` before `crha.service` when systemd is running, so both run the same
version; on a first install it prints `run: sudo crha enroll`. Removal stops, disables and deletes only
the `/etc/systemd/system/crha*.service` units that carry `X-CRH-Managed=1`, then reloads systemd;
`/etc/crha` and `/var/lib/crha` are left alone.

The rpm packages are signed when `CRH_RPM_KEY_FILE` names an ASCII-armored private key; nfpm reads the
passphrase from `NFPM_RPM_PASSPHRASE`. Without it the rpms stay unsigned; the deb package is never
signed.

### Installing crhs with Node

`sudo ./install.sh` copies the directory to `/opt/crhs/versions/<v>/` (a second run with the same
`VERSION` continues), points `/opt/crhs/current` at it and links `/usr/local/bin/crhs` to
`/opt/crhs/current/bin/crhs`. Versions stay side by side, and switching is `ln -sfn`; the unit written by
`crhs init` starts `/usr/local/bin/crhs` because the wrapper exports `CRHS_LAUNCHER`, so it follows the
switch without an edit. On a terminal the installer runs `crhs init`, otherwise it prints the command.
The official Node binary needs glibc and a few system libraries that minimal systems may lack (such as
`libatomic.so.1`); the installer checks that the bundled Node starts before installing anything, and
otherwise shows the error and asks the operator to check its dependencies.
The `crha` installer puts `crha` in `/usr/local/bin` and then runs `crha enroll` on a terminal. Both
installers skip the setup command when its configuration file already exists, so an upgrade only asks
for a restart.

### Container image

The released image is `ghcr.io/kodecable/crhs:<version>`, with `latest` for a stable release. The image
runs as `node` (uid 1000), so the volume behind `/crhs-data` must be writable by uid 1000; the
image creates the directory with that owner for a fresh named volume. With arguments the entrypoint runs
that `crhs` command as given, initialized or not, so `--version` or `keys import` work before a first
start. Without arguments, on the first start it runs `crhs init` with `--answers
/crhs-data/init.json` when that file exists, or interactively when the container has a stdin terminal,
else fails with an explanation; it then runs `serve --config /crhs-data/crhs.toml`.

## Releases

CI (`.github/workflows/ci.yml`) runs the checks, the unit, e2e, bundle and system tests on every push to
`main` and every pull request. Pushing a `v*` tag runs `.github/workflows/release.yml`, which:

- `packages` builds the archives, deb and rpm for amd64 and arm64 in the `release` environment, signs
  the rpms, verifies them with `rpm -K`, signs `SHA256SUMS` with cosign and attests the build provenance
  of the files.
- `image` builds `linux/amd64` on `ubuntu-latest` and `linux/arm64` on `ubuntu-24.04-arm`, one image per
  runner, and pushes each to GHCR by digest.
- `manifest` assembles the images into one manifest tagged `<version>` (and `latest` for a stable
  release), signs it with cosign and attests its provenance.
- `release` opens a draft GitHub release with the artifacts; the maintainer reviews and publishes it.

The version is the tag without its leading `v`. A version containing `-` is a prerelease: it is not
tagged `latest`, and the draft is marked as a prerelease.

Signing is keyless: cosign uses the workflow's OIDC identity for `SHA256SUMS` and the image, and
`actions/attest-build-provenance` attaches build provenance to the files and the image. The rpm
packages are signed with the GPG key `B454E1E9759533CB4E07DA5BEDBB9D378E03F918`
(`packaging/RPM-GPG-KEY-crh`); its private key and passphrase are the `RPM_GPG_KEY` and
`RPM_GPG_PASSPHRASE` secrets of the `release` environment. The workflow fails when the public key has
expired and warns when it expires within 90 days; it also fails when the private key's fingerprint is
not that one. The deb packages are not signed.

Rotate the rpm key yearly: `gpg --quick-set-expire <fingerprint> 1y`, then update
`packaging/RPM-GPG-KEY-crh` and the `RPM_GPG_KEY` secret. On a compromise, revoke the key, publish the
revocation in that file, and replace the key, the secret and the fingerprint in the workflow and docs.

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
| Listen address and port | `127.0.0.1`, `8080` (`0.0.0.0` under `CRHS_DATA_DIR`) | `listen.host`, `listen.port` |
| Database | SQLite | `database.driver` |
| SQLite file | `/var/lib/crhs/crhs.db` | `database.path` |
| PostgreSQL URL (tested at once) | — | `database.url` (secret) |
| Public URL (may stay empty) | empty | `public_url` |
| Administrator username, display name, password | `admin` | `admin.username`, `admin.display_name`, `admin.password` (secret) |
| Install and start the systemd service | yes | `service.install`, `service.start` |

It then creates the `crhs` system user, `/etc/crhs` (root:crhs, 0750) and `/var/lib/crhs` (crhs, 0700);
writes `crhs.toml` (root:crhs, 0640) without `web_root`, so the bundled WebUI is used; creates the master
key, migrates the database, creates the administrator and stores the public URL as a system setting;
installs `crhs.service`, whose `ExecStart` names the running Node and `crhs.mjs`, or `$CRHS_LAUNCHER` when
the packaged wrapper set it; and finally reminds the operator to back up the master key, take a key export
and set up a reverse proxy with TLS. The paths are fixed; a different layout is a manual install.

Every step is skipped when it is already done (the file, key, administrator or unit exists), so an
interrupted init is simply run again.

In the OCI image everything lives in `/crhs-data`: the configuration, the master key, the SQLite
database and the answers file, so one volume holds all state and is the unit of backup. The image sets
`CRHS_DATA_DIR=/crhs-data`, which makes init put every file there instead of the fixed host paths and
default the listen address to `0.0.0.0` instead of the loopback. When `/crhs-data/crhs.toml` is missing,
the entrypoint runs `crhs init --answers /crhs-data/init.json` with `service.install` false (or an
interactive init on a terminal); init then tells the operator to delete the file, which holds the
administrator's password. The image creates no system user and no unit.

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

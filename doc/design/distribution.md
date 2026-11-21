# Distribution and setup

How crhs and crha are packaged, how `crhs init` and `crha enroll` set up a host, and how crhs upgrades
its crha nodes ([crha self-upgrade](#crha-self-upgrade)). crhs's own self-upgrade is not designed yet.

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
| `crhs-<v>.tar.gz` (`crhs-<v>/`) | `crhs.mjs`, `web/`, `doc/`, `package.json`, `package-lock.json`, `THIRD_PARTY_LICENSES.txt`, `VERSION`, `LICENSE`, `README.txt` | No |
| `crhs-<v>-linux-<arch>.tar.gz` (`crhs-<v>-linux-<arch>/`) | the bundle, WebUI and documentation, `node/` (the official `bin/node`), `node_modules/re2` for the arch, `bin/crhs`, `install.sh`, licenses, `VERSION` | Planned |
| `crha-<v>-linux-<arch>.tar.gz` (`crha-<v>-linux-<arch>/`) | the static `crha`, `install.sh`, `LICENSE`, `THIRD_PARTY_LICENSES.txt`, `VERSION` | Pushed by crhs ([crha self-upgrade](#crha-self-upgrade)) |
| `crhu-<v>-linux-<arch>.tar.gz` (`crhu-<v>-linux-<arch>/`) | the static `crhu`, `LICENSE`, `THIRD_PARTY_LICENSES.txt`, `VERSION` | Planned |
| crhs OCI image | Node, the bundle, the WebUI, the documentation and re2 | No; pull a new image |
| `crha_<debversion>_<arch>.deb`, `crha-<rpmversion>-1.<rpmarch>.rpm` | `crha` in `/usr/bin` and the licenses in `/usr/share/doc/crha`, built with nfpm and the `pkgmanaged` tag | Never; the package manager updates it |
| `crhu_<debversion>_<arch>.deb`, `crhu-<rpmversion>-1.<rpmarch>.rpm` | `crhu` in `/usr/bin` and the licenses in `/usr/share/doc/crhu`, built with nfpm and the `pkgmanaged` tag | Never; the package manager updates it |

`arch` is `amd64` or `arm64`. Archives are deterministic-ish: entries sorted by name, the mtime of the
tree's last commit, owner 0:0, `gzip -n`. The archive without Node is installed by hand: run
`npm ci --omit=dev` once in the unpacked directory (it downloads or builds re2), then `node crhs.mjs init`
and `node crhs.mjs serve`.

`pnpm build:crhs` produces the common part in `dist/crhs`: esbuild bundles the server and every pure
JavaScript dependency into `crhs.mjs`, and the WebUI and the documentation (`doc/**/*.md`, without
images) are copied next to it. Only native modules stay outside: `re2` is shipped with its runtime
files, and `cpu-features` is optional for `ssh2`, which falls back to JavaScript and WebAssembly. The
version is injected at build time; an unbundled crhs reports `dev`. The archive with Node carries Node's
LICENSE appended to `THIRD_PARTY_LICENSES.txt`; the `crha` and `crhu` archives collect the Go modules'
licenses.

### crha deb and rpm

`pnpm package` builds `crha_<debversion>_<arch>.deb` and `crha-<rpmversion>-1.<rpmarch>.rpm` with nfpm,
which must be on `PATH`; the `amd64`/`arm64` architectures become `x86_64`/`aarch64` in the rpm name. A
prerelease `1.2.0-rc.1` is packaged as `1.2.0~rc.1`, because dpkg and rpm sort `~` before the release
and a `-` after it. A version that does not start with a digit, such as a `git describe` result, is
packaged as `0.0.0~git<version>`, with `-` replaced by `.`. The `~` stays in the package metadata but
becomes `-` in the file names, since GitHub release assets cannot carry it. The packages contain only `/usr/bin/crha` (with the
`pkgmanaged` build tag) and `/usr/share/doc/crha/{LICENSE,THIRD_PARTY_LICENSES.txt}`; they create no
user, directory or unit, because `crha enroll` does that. `crha version` then prints `package-managed`,
and `crha upgrade` refuses in favour of apt or dnf.

The nfpm scripts in `packaging/nfpm/` are shared by deb and rpm. On an upgrade the postinstall script
restarts `crha-privileged.service` before `crha.service` when systemd is running, so both run the same
version; on a first install it prints `run: sudo crha enroll`. Removal stops, disables and deletes only
the `/etc/systemd/system/crha*.service` units that carry `X-CRH-Managed=1`, then reloads systemd;
`/etc/crha`, `/var/lib/crha` and `/var/lib/crha-privileged` are left alone.

The rpm packages are signed when `CRH_RPM_KEY_FILE` names an ASCII-armored private key; nfpm reads the
passphrase from `NFPM_RPM_PASSPHRASE`. Without it the rpms stay unsigned; the deb package is never
signed.

### crhu deb and rpm

`crhu` is packaged the same way as `crha`, with `pkgmanaged`, but the package contains only
`/usr/bin/crhu` and `/usr/share/doc/crhu/{LICENSE,THIRD_PARTY_LICENSES.txt}`. It has no install
scripts and no service: `crhu` is a workstation signing tool that uses the local `ssh-keygen` and
ssh-agent, and its archive likewise has no `install.sh`. It is built from the same Go module as `crha`.

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
| Enroll again with a new key (asked first when already enrolled; no keeps the enrollment, needs no token and skips the enrollment step) | no | `replace` |
| crhs address (not asked when keeping the enrollment) | the existing one, none for a new node | `server` |
| Enrollment token (not asked when keeping the enrollment) | — | `token` (secret) |
| Check the TLS certificate against the system CAs (the token's fingerprint authenticates crhs either way) | the existing setting, yes for a new node | `tls_verify` |
| Privileged mode: `ignore` or `forward` | the existing mode, `ignore` for a new node | `privileged.mode` |
| Keep the current trust entries (forward, when `privileged.toml` exists): names them, never prints them | yes | (`privileged.trust` given replaces them) |
| Let local root open the local approval window (forward, for new trust entries) | yes | `privileged.local_root` |
| Trust entries from the WebUI's **Generate trust config**, ending with a line `.`; empty to configure later (forward, for new trust entries) | empty | `privileged.trust` |
| Start the services | yes | `service.start` |

`native` and `reject` are left to a manual `crha.toml`; enroll keeps them as the default of the mode
question.

On a new node it then creates the `crha` user and group when missing, `/etc/crha` (root:crha, 0750)
and `/var/lib/crha` (crha, 0700); writes `crha.toml` (root:crha, 0640); enrolls, writing the keys and
`node_id` (owned by crha) only after crhs accepted the token; for `forward`, creates
`/var/lib/crha-privileged` (root, 0700) and writes `privileged.toml` (root, 0600) with the enrolled node
id, crha's uid, the local root entry and the pasted entries, which are parsed first; writes and enables
the units, starting them if asked; and prints the node id and key fingerprint to compare when
approving the node in the WebUI.

### Switching a node set up before

On a node set up before, the existing files give the defaults, and an answer that differs switches the
node to it, from the questions or from an answers file alike:

- `crha.toml` is edited in place with go-toml's comment-preserving editor: only the changed keys are
  rewritten, and switching to `forward` adds the privileged socket it needs.
- Switching to `forward` writes `crha-privileged.service`; a new `privileged.toml` needs the node id,
  which only an enrollment returns, so when keeping the enrollment `privileged.toml` must already exist.
  Leaving `forward` disables and removes `crha-privileged.service` and keeps `privileged.toml` for a way
  back.
- Replacing the trust entries removes every `[[trust]]` table of `privileged.toml` and appends the new
  ones; `node_id`, the other keys and their comments stay as they were. The same entries again (a rerun
  with the same answers) change nothing.

Enroll plans every change first and checks it, then goes in the order of an upgrade
([On the node](#on-the-node)), reusing its steps:

1. **Stop** the units whose files are present, `crha-privileged` and `crha`, when anything changes or
   the node enrolls again. crha must not run on a key or configuration being replaced, and the privileged
   mode keeps writing its state while it runs. A failure from here on starts them again.
2. **Register**, when enrolling again, against `crha.toml` as the run will leave it. A refused token
   changes no file. The node id it returns completes the plan ([Same node or new
   node](#same-node-or-new-node)).
3. **Back up** the node's fixed set ([Backups](#backups)) when a file changes, then write the files.
4. **Start** the units, privileged mode first, when they are to be started; otherwise stopped units stay
   stopped.

A rerun that changes nothing stops, backs up and writes nothing.

### Same node or new node

Enrolling again always gives the node a new key; what else happens is decided by the token, which only
crhs knows: a Re-enroll token keeps the node's record (id, name, groups, grants, history), a New node
token registers another node, and so does any token from another crhs (the crhs address changes only
this way; keeping the enrollment refuses a different one). So enroll asks one question and tells the
two apart after registering, by the node id crhs returns:

- Every enrollment records the id in `<state_dir>/node_id`, moved aside and restored with the keys when
  an enrollment fails. The previous id is that file, or, on a node enrolled before crha kept it, the
  `node_id` of `privileged.toml`.
- The same id: "enrolled node X again with a new key".
- Another id: "enrolled as a new node Y", and that the previous node stays on crhs until deleted in the
  WebUI. When `privileged.toml` exists, its `node_id` is edited to the new id (in any mode, so a copy
  kept outside `forward` still works on the way back); otherwise the privileged mode would refuse every
  task of the new node.
- A different crhs address is named in the confirmation summary as a new node of that crhs before
  anything runs.

### crha register

`crha register --config <file>` is the step underneath, for a manual layout and for tests: it reads
the token from standard input, uses the server and paths of an existing `crha.toml`, and only registers
the node (with `--replace` to enroll again). It creates no user, file or unit. `crha enroll` calls the
same Go code rather than running `crha register`, so nothing passes through a command line twice.

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

## crha self-upgrade

crhs upgrades a crha node to crhs's own version: it fetches that
version's release, verifies it, and sends it to the node as a privileged task. On the node the old
binary only receives and checks the new one; the new binary then backs up, migrates and regenerates
everything and takes over. crhs is always upgraded first, and talks to nodes of an older protocol major
through an [upgrade-only connection](protocol.md#upgrade-only-connections) until they follow.

### Who can self-upgrade

A node reports whether it can be upgraded this way, and why not, in its facts as `self_upgrade`:
`available`, a list of `reasons`, and `arch`, the architecture of the binary it needs (`platform` is
for people and is never parsed). crhs upgrades a node only when `available` is true; it does not guess.
The unprivileged mode works out the reasons that hold for its lifetime at start, and adds the forward
daemon's state each time it sends its facts, which it does again whenever that state changes. The
reasons are open names, so crhs shows a reason from a newer crha as it is:

| Reason | Meaning |
|---|---|
| `package_managed` | Built with `pkgmanaged`; apt or dnf upgrades it. Package-managed nodes are never self-upgraded. |
| `not_systemd` | The unprivileged mode was not started as a systemd service (its cgroup is not a `.service`). |
| `unmanaged_unit` | A unit the node runs under does not carry `X-CRH-Managed=1`: `crha.service`, and `crha-privileged.service` in `forward` mode. A node set up by hand gives up self-upgrade rather than having its units rewritten or skipped. |
| `unit_mismatch` | The managed units do not start the same executable, or not the one that runs. |
| `no_privilege` | Nothing on the node can write the binary as root: `reject` mode, or `ignore` mode without running as root. (`native` always escalates to root.) Units written by `crha enroll` run crha as the crha user, so an `ignore` node set up that way reports it; one that runs crha as root through a drop-in (`systemctl edit crha`: `User=root`) can self-upgrade, and the upgrade keeps the drop-in. |
| `privileged_not_root` | In `forward` mode the privileged mode does not run as root (seen through `SO_PEERCRED` on its socket). |
| `privileged_unavailable` | In `forward` mode the privileged mode does not answer, or runs another `crha_version`. |

An available node still needs an authorization like any privileged task: self-upgrade never bypasses
the node's trust configuration ([Methods and targets](privilege.md#methods-and-targets)).

### Fetching the release

crhs fetches crha from the GitHub release whose tag is `v` followed by crhs's version, whatever kind of
release it is (stable or prerelease). It fetches only that version, and only the architectures the
selected nodes report. `crhs.toml` configures it:

```toml
[crha_release]
url = "https://github.com/Kodecable/ClusterRightHand"  # the repository
download = true
verify = true
```

- The assets are read straight from `<url>/releases/download/v<version>/<asset>`, without the GitHub API
  and its rate limit: `crha-<version>-linux-<arch>.tar.gz`, `SHA256SUMS` and `SHA256SUMS.sigstore.json`.
- A build whose version is not a release (`dev`, a `git describe` result) has nothing to fetch, and
  fetching fails and says so.
- The cache is `<data>/crha-releases/<version>/`, holding the assets unchanged under their release
  names. This layout is a documented interface: with `download = false`, or for a build without a
  release, the operator copies the assets there by hand; there is no import command. crhs reads the binary out of the archive when
  it sends it, so the cache holds no derived files. Other versions' directories are removed at startup.
- Downloads go through the wrapped global fetch, so they carry crhs's User-Agent
  ([Outbound requests](architecture.md#outbound-requests)); the Sigstore client is given the same fetch.

Downloading and verifying are separate steps, run once per version and architecture however many tasks
wait for them (single flight), and verification runs every time a release is about to be sent; no
"verified" marker is stored.

1. **Download** each missing asset, when `download` is true; otherwise a missing archive fails and names
   the path to copy it to.
2. **Verify.** With `verify = true`, both checks are mandatory:
   - the Sigstore bundle must verify `SHA256SUMS`, with the certificate identity
     `https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v<version>` (derived
     from `url`) and the issuer `https://token.actions.githubusercontent.com`;
   - the archive's SHA-256 must match its line in `SHA256SUMS`.

   Verification needs the network: the Sigstore trusted root is refreshed through TUF every time, and
   there is no fallback to a bundled or cached root. A host that cannot reach GitHub and the Sigstore TUF
   repository must turn verification off. With `verify = false` the signature is not checked, but when
   `SHA256SUMS` is present the archive is still checked against it; without it the archive is used as
   is. A `url` that is not a `github.com` repository is a configuration error unless `verify` is false.
3. **On failure**, crhs tells the two kinds apart. A definite failure (a bad signature, a wrong
   identity, a hash mismatch, a malformed file) deletes the files it condemns and downloads them again,
   at most twice per run; with `download = false` nothing is deleted and the run fails. A failure to
   verify at all (the network, TUF) deletes nothing and fails the run, since it proves nothing about
   the files.

### The upgrade task

The upgrade is one task of kind `node.upgrade` per node, privileged, with the method `upgrade`
([Methods and targets](privilege.md#methods-and-targets)). Its spec holds the target version, the
architecture, and the binary's size and SHA-256; the bytes travel on a data connection like
`file.push`'s ([File plane](library.md#file-plane)). It goes through rules, approvals and the
authorization planner like every privileged task, and several nodes are one task group signed once. A
`spec` authorization binds the binary's hash, so a user signing with `crhu` can compare it with the
release's `SHA256SUMS`. Nodes of different architectures receive different specs, so crhs makes one
group per architecture.

`POST /api/nodes/upgrade` (administrators; an agent's call needs approval) takes nodes and node groups
like a task group, and answers the plan: the nodes it upgrades, with their running tasks, and the nodes
it skips with a reason: not a crha node, not connected, `self_upgrade` not available (with the node's
reasons), no `arch` reported, already at crhs's version, newer than crhs (there is no downgrade:
configuration migrations only go forward), or a version that is not a release. With `dryRun` it stops
there and fetches nothing; the WebUI shows that plan before it starts. Otherwise it fetches and
verifies the release once per architecture, stages the binary and starts the groups, and records
`node.upgrade_requested` in the audit log.

`node.upgrade` is not in the major's base set of task kinds: crhs sends it only to a node whose `hello`
lists it, and ends it `unsupported_kind` otherwise ([Version
negotiation](protocol.md#version-negotiation)).

### On the node

The privileged side runs the task: the privileged mode in `forward`, the helper in `native`, crha itself
in `ignore` as root. It only receives and checks the new binary and hands over; everything else happens
in the new binary, through a hidden subcommand, so new logic ships with the new version and the old
file can be freed. No step uses a shell; `systemd-run`, `systemctl` and
`journalctl` are run directly.

1. **Receive (old binary).** The binary travels on a data connection with the file plane's machinery:
   the `[crhs, transfer_id]` endpoint, the per-node and per-crhs transfer queues, the idle timeout, the
   backpressure and the final size and SHA-256 check ([File plane](library.md#file-plane)). It is a task
   kind of its own rather than a `file.push`, because the node chooses where it goes (the spec has no
   path) and the method is `upgrade`. In `forward` the unprivileged mode relays it as `task.input` over
   `crh-priv` and the privileged mode writes it, as for a privileged `file.push`; in `native` the helper
   receives it through its input queue and writes it; in `ignore` crha writes it. It is written to
   `/var/lib/crha-upgrade/backups/task-<task id>/crha`, this upgrade's backup directory, hashed as it
   arrives (`/var/lib/crha-upgrade` is root's, 0755; `backups` and each backup are 0700), and a wrong
   size or hash fails the task. It never passes
   through a directory the unprivileged mode can write: the version must look like a version, the
   directories must be root's and real directories, and the file is created without following links.
2. **Hand over (old binary).** Start the new binary in a transient unit, outside crha's cgroups, so that
   stopping crha's services does not kill it: `systemd-run --unit crha-upgrade-<task id> --collect
   /var/lib/crha-upgrade/backups/task-<task id>/crha __upgrade-install --from <old version> --to <version> --task
   <task id>`. The task id names the unit, so a unit left by an earlier upgrade cannot collide. The task
   then ends successfully: its result means "handed over", and the old crha reports it. The new crha never
   learns of the task.

   When the old crha receives the `task.exit.ack` for that task, it logs the hand-over line
   `crha upgrade handed over: crhs confirmed task <id>`. It does not exit or stop anything itself.
3. **Plan (new binary, transient unit).** Take the install lock (`/var/lib/crha-upgrade/install.lock`)
   and refuse anything but an upgrade from a release to a newer release: there is no downgrade, so every
   upgrade's `from` is lower than its `to`, which a rollback by hand relies on. Then work
   out the node as this version sets it up, changing nothing yet:
   - Read `crha.service`: its `X-CRH-Meta` gives the mode and the configuration, its `ExecStart` the
     binary to replace. A unit crha did not write stops the install here.
   - Read the [fixed set](#backups) of files; one that is absent is recorded as such.
   - Render the units with this version's templates, the same function `crha enroll` writes them with.
   - Migrate `crha.toml` and `privileged.toml` ([Configuration migrations](#configuration-migrations)).
   - Self-test: this version's strict parsers must read the migrated files.

   A failure here leaves the node as it was, with the old crha still running.
4. **Wait for the hand-over.** Search the journal for the hand-over line, matched on the `_SYSTEMD_UNIT`
   field journald sets and on the task id, over the current boot, so a line logged before the search
   began still counts; then keep following for up to 60 seconds. The task id is unique, so no other line
   can stand in for it, and no pid is needed (a `native` helper's parent is sudo, not crha). Without it, give up with nothing changed: the old crha keeps running and a late
   confirmation only adds a log line. A missing confirmation means crhs is unreachable, and the readiness
   check below needs crhs, so going on would only end in a rollback.
5. **Stop.** `systemctl stop crha crha-privileged`: both old processes must be gone before anything
   changes, because the privileged mode keeps writing its state and still answers local `crha approve`
   after the unprivileged mode has stopped; a used-list entry lost to a migration would allow a replay.
   Stopping ends the node's other running tasks, which a restart
   would end anyway.
6. **Install.**
   - Set the host up as `crha enroll` does: the system user and the directories crha needs, with their
     owners and modes. Nothing that is already right changes, and none of it is undone by a rollback.
   - Back up the fixed set to `task-<task id>` ([Backups](#backups)); the upgrade log names the
     manifest.
   - Write the files whose content changes next to their targets and rename them into place, the binary
     last (it copies itself). A configuration file no migration changed is not written: it stays byte for
     byte. Renaming over the binary is safe while processes run from it (they keep the old inode); the
     old file is freed when the last one exits. Then `systemctl daemon-reload` and `enable` the units.
7. **Activate.** Note the time, start `crha-privileged` before `crha`, as the packages do, and follow the
   journal (`journalctl -f -o json`) for the readiness line of the new version, matched on
   `_SYSTEMD_UNIT` and logged after that time. The line names the version, which the old binary cannot
   print, so no older line can stand in for it, and a crha that systemd restarts after a crash still
   counts. crha logs its readiness line, a human-readable sentence with a fixed keyword (`crha ready:
   connected to crhs, privileged mode ok (version 1.3.0)`), once it has completed a handshake with crhs
   and its privileged side works: in `forward` a `crh-priv` handshake with an equal `crha_version`, in
   `native` a helper started for the purpose and its handshake completed, in `ignore` nothing more. The
   line and its matcher come from the same binary, so its format is not a contract between versions.
8. **Roll back** when the line does not appear within 120 seconds, or when a step after the stop fails:
   restore the fixed set from the manifest, `systemctl daemon-reload`, and start the units. The rollback
   does not check the old version's health. A step that fails before the backup has replaced nothing:
   the stopped services are only started again.

The hand-over line is written by the old version and matched by the new one, so unlike the readiness
line it is a contract between versions: it is part of each major's frozen upgrade path
([Compatibility across majors](protocol.md#compatibility-across-majors)).

### Configuration migrations

A migration is a step of the upgrade, not a way of reading a file: the new version's parsers stay strict
and refuse an unknown key, and the migrations are what turns an older file into one they read. A
migration names the first version that needs it, the file, and a list of edits: set a key, delete a key,
or rename one (its value and comments move with it). It runs on an upgrade from an older version to
that version or a newer one.

- The edits go through the comment-preserving editor of go-toml (`unstable/edit`): what no edit names
  stays as it was, byte for byte, comments and order included. Comments inside an array are kept less
  reliably: deleting an element can take a comment that stands above the next one.
- After each edit both versions of the document are decoded, and they must differ by exactly that edit,
  so a defect of the editor stops the upgrade instead of being installed.
- Each edit is written to the upgrade log.
- Migrations make no promise about behavior. A release may turn a default off for safety, rename or drop
  a key, and its release notes say what changed. The one requirement is that the result needs no one's
  help: the self-test must pass.

There are no migrations so far. The editor comes from go-toml, a dependency crha already has, whose
`unstable/edit` is not in a release yet: crha depends on the upstream commit that adds it, until a
release contains it.

### Upgrade log

The installer and a rollback by hand write `/var/lib/crha-upgrade/upgrade.jsonl` (root, 0644), and only
while they hold the install lock: a process that does not get the lock says so on its standard error
and writes nothing. One JSON object per line, `{"ts", "upgrade_id", "from", "to", "level", "step",
"msg"}`, and `manifest` on the line that records the backup; each upgrade ends with a line whose step
is its outcome, `activated`, `rolled_back` or `failed`, with the reason. The file holds at most 128
lines; each write drops the oldest lines past that and replaces the file by a rename, which is safe in
a directory only root can write. An upgrade writes a few dozen lines, so the log keeps the last several
upgrades.

crha reports the log's path in its facts as `upgrade_log_path`, as it reports its notes' path
([Node notes](agent-runtime.md#node-notes)), and crhs reads it on demand with an ordinary `file.read`.
crhs does not record the outcome on its own; the node's version in its next handshake shows whether it
moved to the target version, and the log says why not.

On the node:

- `crha upgrade status` prints the last upgrade's outcome and what a rollback would do, then the log.
- `crha upgrade rollback` (as root) undoes the upgrade that produced the running version, for when the
  new version cannot reach crhs. The running version is `crha.service`'s `X-CRH-Meta` version; the
  upgrade is the latest `activated` one whose target is that version, and it must come from a lower
  release. The rollback takes the install lock, checks every file of the set against the hash the
  upgrade left, and refuses when one changed since (`--force` restores anyway), then restores the set,
  reloads systemd, starts the units and logs `rolled_back`. Matching the running version means an
  upgrade already rolled back, by the installer or by hand, is never undone twice; running it again steps
  back through an older upgrade while its backup is kept.

### Backups

An upgrade, and an enrollment that changes a node set up before, back up the node's **fixed set** first:
the binary, `crha.toml`, `privileged.toml`, `crha.service` and `crha-privileged.service`, always all of
them, so a restore puts back one consistent set. The identity key and `node_id` are never part of it (a
copy of the key is one more place to leak it), nor the privileged mode's state (restoring the used list
would allow a replay), its local log or the output files. One backup is one directory below
`/var/lib/crha-upgrade/backups/` (root, 0700) with the copies and a manifest: each file's backup, mode
and owner (or that it was absent), and the SHA-256 crha left in it.

| Kind | Directory | Kept | Used by |
|---|---|---|---|
| Upgrade | `task-<task id>`, which also holds the received binary | the last 2 | `crha upgrade rollback` |
| Enrollment | `enroll-<UTC time>` | the last 5 | a restore by hand; enroll prints the directory |

Old backups are removed at the start of every upgrade and at the end of every enrollment that changed
something, whatever the outcome, so a failed upgrade does not leave its binary behind for long.

### Design review

These questions were raised while this design was made; the sections linked answer them. **Any change
to how crha self-upgrades or enrolls (who acts, in which order, through which channel, with which
files) must review every one of them again**, and add the new questions it raises.

- How is a download trusted? ([Fetching the release](#fetching-the-release))
- What about hosts that cannot reach GitHub or Sigstore? ([Fetching the release](#fetching-the-release))
- What happens to a bad or corrupt download? ([Fetching the release](#fetching-the-release))
- Who drives the upgrade on the node? ([On the node](#on-the-node))
- Why plan before the stop? ([On the node](#on-the-node), step 3)
- Should the installer be a child of the old service? ([On the node](#on-the-node), step 2)
- The old crha should stop soon after reporting; what if the installer times out? ([On the
  node](#on-the-node), steps 2 and 4)
- How does the installer find the old crha's lines without its pid? ([On the node](#on-the-node), steps
  4 and 7)
- In `forward`, can the old privileged mode keep running during the install? ([On the
  node](#on-the-node), step 5)
- Who reports the task? ([On the node](#on-the-node), step 2; [Upgrade log](#upgrade-log))
- How is health checked? ([On the node](#on-the-node), steps 7 and 8)
- Can a downgrade happen? ([The upgrade task](#the-upgrade-task); [On the node](#on-the-node), step 3)
- Is a configuration migration a lenient way of parsing? ([Configuration
  migrations](#configuration-migrations))
- Do migrations keep behavior? ([Configuration migrations](#configuration-migrations))
- Why depend on an unreleased go-toml? ([Configuration migrations](#configuration-migrations))
- What is backed up, where, and for how long? ([Backups](#backups))
- Where does the outcome go? ([Upgrade log](#upgrade-log))
- Can two writers race on the log? ([Upgrade log](#upgrade-log))
- How does a rollback by hand know what to undo? ([Upgrade log](#upgrade-log))
- Can the upgrade bypass node trust? ([Who can self-upgrade](#who-can-self-upgrade); [Methods and
  targets](privilege.md#methods-and-targets))
- Should the WebUI's generated trust config deny `upgrade`? ([Methods and
  targets](privilege.md#methods-and-targets))
- Does enroll stop the services before it changes the node, as an upgrade does? ([Switching a node set
  up before](#switching-a-node-set-up-before))
- How does enroll tell a new key for this node from a new node? ([Same node or new
  node](#same-node-or-new-node))

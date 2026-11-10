# Command-line reference

ClusterRightHand has two command-line programs. `crhs` runs on the server host and manages the
server, its users and its keys. `crha` runs on a node, enrolls it, keeps it connected and handles
privileged tasks. Both use subcommands; `--help` prints the commands and flags described here.

## crhs

```text
usage: crhs [--config <path>] <command>

commands:
  serve                                 run the server (default)
  user add <username> [--admin] [--display-name <name>]
                                        create a user; the password is read from the terminal or stdin
  user passwd <username>                set a user's password
  keys init                             create the master key file (master_key_file)
  keys export --out <file>              write the master key and server keys to a passphrase-encrypted age file
  keys import <file>                    restore the master key file from an export, after checking it against the database
```

`serve` is the default: `crhs` with no command starts the server. `-h` and `--help` print this text
and exit 0 without reading the configuration.

Options:

| Option | Default | Used by | Meaning |
|---|---|---|---|
| `-c, --config <path>` | `/etc/crhs/crhs.toml` | all commands | Configuration file. See [crhs.toml](crhs-config.md). |
| `-o, --out <file>` | none | `keys export` | Output file for the key export. Required by `keys export`. |
| `--admin` | off | `user add` | Create the user as an administrator instead of a regular member. |
| `--display-name <name>` | the username | `user add` | Display name shown in the WebUI. |
| `-h, --help` | | all commands | Print usage and exit 0. |

Options may appear before or after the command. An unknown option is a parse error and the command
does not run.

**Startup and exit codes.**

Every command follows the same start-up sequence:

1. Parse the options and load the configuration. A file that cannot be read or parsed is reported
   as `crhs: <path>: <message>` and the process exits with code 2.
2. Configure the Argon2id gate from `[auth]`.
3. Open the database and run all pending schema migrations. This happens for every command,
   including `keys init` and `user add`, so a fresh database is created and migrated before the
   command does its work.
4. Run the command.

| Exit code | Meaning |
|---|---|
| 0 | The command succeeded, or `--help` was printed. |
| 1 | An expected refusal: a missing or unusable master key file, a master key that does not belong to the database, a duplicate user, a password that is too short, an export file that already exists. The message is printed as `crhs: <message>`. A failed or timed-out shutdown also exits 1, and so does a second SIGINT or SIGTERM during shutdown. |
| 2 | The configuration could not be loaded, or the command line was not understood (unknown command, missing argument, missing `--out` for `keys export`). Usage is printed for a command-line error. |

An unexpected error (for example a database that cannot be opened or a migration that fails) is not
caught; Node prints it and the process exits with code 1.

**Reading passwords and passphrases.**

No password or passphrase is ever accepted as an argument.

- On a terminal, `crhs` prompts on stderr with echo disabled. For a new password or a new export
  passphrase it asks twice and refuses the input if the two entries differ.
- When stdin is not a terminal, it reads one line from stdin and does not ask for a repeat. This is
  the scripting path: `printf '%s\n' "$PASSWORD" | crhs user add alice`.

A user password must be at least 8 characters; the check counts Unicode code points. An empty export
passphrase is refused.

**`crhs serve`.**

```sh
crhs serve --config /etc/crhs/crhs.toml
```

Starts the HTTP API, the WebUI, the WebSocket endpoint for nodes, the agent runtime, the scheduler
and the background sweeps. It reads the master key file named by `master_key_file`, checks that it
belongs to the database and starts listening on `[listen]`. On success it prints one line:

```text
crhs listening on http://127.0.0.1:8080 (identity <base64url fingerprint>, signing key SHA256:…)
```

`SIGINT` and `SIGTERM` start a graceful shutdown: the server stops accepting requests, ends open
streams and waits for in-flight work, then closes the database. Shutdown is given 10 seconds; after
that the process exits 1. A second signal during shutdown also exits 1.

The process does not reload its configuration; restart it to apply an edit. It does not terminate
TLS itself; put a reverse proxy in front of it (see [Reverse proxy and TLS](../install.md#reverse-proxy-and-tls)).

**`crhs user add`.**

```sh
crhs user add alice --admin --display-name "Alice Example"
```

Creates an active user in the default organization. The username is trimmed and lowercased, then
must match `^[a-z0-9][a-z0-9._-]{0,63}$`; a name that does not match, an existing name and a
password shorter than 8 characters are refused. The password is read as described above. Without
`--admin` the user is a regular member. The command prints:

```text
created admin alice (0192f000-0000-7000-8000-000000000002)
```

**`crhs user passwd`.**

```sh
crhs user passwd alice
```

Sets a new password for an existing user after the same password check. An unknown username is an
error. The command prints `password updated for alice`.

**`crhs keys init`.**

```sh
crhs keys init
```

Generates a new 32-byte master key, records its id in the database and writes it to
`master_key_file` as base64 with mode 0600. The file is created exclusively: if it already exists,
the command fails with `<path> already exists` and does not overwrite it. The database must not
already be bound to a different master key, otherwise the command fails with a master-key id
mismatch. The command prints:

```text
created /etc/crhs/master.key; back it up with "crhs keys export"
```

The key id is recorded before the file is written. If writing fails (for example because the file
already exists), the database is already bound to the generated key, which was never saved; a later
`keys init` refuses with a master-key id mismatch. In that situation, restore the key file that
matches the database, or start from a fresh database.

**`crhs keys export`.**

```sh
crhs keys export --out /root/crhs-keys.age
```

Reads the master key, checks it against the database, asks for an export passphrase and writes an
ASCII-armored [age](https://age-encryption.org/) file encrypted with that passphrase (scrypt). The
file is created with mode 0600 and is never overwritten: an existing path is refused. It contains
the master key and the decrypted values of the server identity key and the authorization signing
key. It is not a database backup: `crhs keys import` checks every exported server key against the
existing database and only restores the master key file. Node keys and user credentials are not part of
the export.

The file can be decrypted with the standard `age -d` tool. The command prints:

```text
exported the master key and 2 server key(s) to /root/crhs-keys.age
```

`keys export` is a local command only. It is not exposed through the WebUI or the API: exporting
requires reading `crhs.toml` and the master key file, which means access to the server host.

**`crhs keys import`.**

```sh
crhs keys import /root/crhs-keys.age
```

Decrypts an export, checks it against the database and writes the master key file. The checks are:
the export must be a `crh-keys` version 1 document whose master key id matches the database (when the
database already has one), and every server key in the export must still exist in the database with
the same value. Any mismatch stops the import. The master key file is created exclusively, so an
existing file is not replaced. The command prints:

```text
restored /etc/crhs/master.key (master key id 0123456789abcdef0123456789abcdef)
```

Restore procedure: restore the database backup first, then run `keys import`. The export is useless
without the passphrase, and the database is useless without the master key.

## crha

```text
crha [command]
```

`crha` with no command prints its help and exits 0. The commands that read a configuration file
define their own `--config`; there is no global configuration option. `crha --help` lists the
commands.

| Command | Purpose | Status |
|---|---|---|
| `run` | Run the unprivileged mode. | Implemented |
| `enroll` | Enroll this node with a crhs server. | Implemented |
| `status` | Show this node's identity and configuration. | Implemented |
| `rotate-key` | Rotate the node key. | Not implemented yet |
| `upgrade` | Apply a crha binary upgrade. | Not implemented yet |
| `version` | Print version information. | Implemented |
| `privileged run` | Run the privileged mode. | Implemented |
| `privileged stdio` | Execute one task as the native helper. | Implemented |
| `grant` | Sign an authorization. | Implemented |
| `pending` | List tasks waiting for local approval. | Implemented |
| `approve` | Approve a task locally. | Implemented |
| `deny` | Deny a task locally. | Implemented |

cobra also provides `crha help [command]` and `crha completion <bash|zsh|fish|powershell>`. They
are the standard cobra commands and have no CRH-specific behaviour.

Every error ends the process with exit code 1 and one line on stderr, `crha: <message>`; usage is not
printed again. A successful command exits 0. `SIGINT` and `SIGTERM` stop the long-running commands
gracefully.

**`crha run`.**

```sh
crha run --config /etc/crha/crha.toml
```

Runs the unprivileged mode: it loads `crha.toml`, loads the node identity key and the pinned server
key from `state_dir`, creates the output directory if needed, starts the output cleanup, connects to
crhs and serves tasks until it is stopped.

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | required | Path to `crha.toml`. |
| `-h, --help` | | Print usage and exit 0. |
| `--pprof-listen <addr>` | off | Only in a build made with `-tags pprof`: serve Go pprof on `unix:/absolute/path.sock` or a loopback TCP address such as `127.0.0.1:6060`. Any other address is refused. |

Start-up checks, in order:

- The task environment must resolve: a usable `sh` and, if `CRHA_TASK_SHELL` is set, an absolute
  executable. A failure stops the process before it connects.
- `identity.key` must exist and must not be accessible by group or others. If it is missing, the
  message tells you to run `crha enroll` first.
- `server.pub` must exist; it is the pinned crhs key written by `crha enroll`.
- The output directory is created with mode 0700 if it does not exist.

On success it logs `crha starting` with the WebSocket URL and the node key fingerprint, then keeps
running. A node that crhs rejects ends the process with the rejection reason and exit code 1.

`SIGHUP` re-reads `crha.toml`; see [the configuration reference](crha-config.md#configuration-file)
for which changes apply immediately and which need a restart.

**`crha enroll`.**

```sh
crha enroll --config /etc/crha/crha.toml --state-dir /var/lib/crha \
  https://crh.example.com 'crh1.<fingerprint>.<secret>'
```

Enrolls the node. The two positional arguments are the crhs base URL and an enrollment token created
in the WebUI. The token has the form `crh1.<server-key-fingerprint>.<secret>`; the fingerprint is
what makes the token alone sufficient to bootstrap trust.

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | required | Path to `crha.toml`. |
| `--state-dir <path>` | none | Absolute state directory written into a new configuration file. Only allowed when `--config` does not exist. |
| `-h, --help` | | Print usage and exit 0. |

The command:

1. Parses the token; a malformed token is refused before any network access.
2. Loads `--config`. If the file does not exist and `--state-dir` is given, it writes a minimal file
   containing only `server` and `state_dir`; the values are validated before the file is written.
   If the file exists and `--state-dir` is also given, the command fails; the state directory of an
   existing file is the one in the file.
3. Refuses to continue when `identity.key` already exists. To enroll the node again, remove both
   `identity.key` and `server.pub` (neither file is overwritten) and use a new enrollment token.
4. Resolves the task environment, because the enrollment facts include the discovered shells.
5. Fetches `GET <server>/agent/identity` and accepts the returned public key only when its
   fingerprint equals the one in the token. With `tls_verify = "none"` the TLS certificate is not
   verified, but the fingerprint check still applies.
6. Generates a new node identity key and performs the Noise handshake with an `enroll` payload
   carrying the token secret, the hostname and the facts.
7. Only after crhs accepts the enrollment, writes `server.pub` (mode 0644) and `identity.key` (mode
   0600). A rejected token leaves no half-enrolled state.

It prints the assigned node id and the node key fingerprint:

```text
enrolled as node 0192f000-0000-7000-8000-000000000001, waiting for approval
node key fingerprint: <base64url fingerprint>
```

The node stays pending until an administrator approves it in the WebUI, comparing the fingerprint
printed here. See [Node registration](../../design/protocol.md#node-registration).

**`crha status`.**

```sh
crha status --config /etc/crha/crha.toml
```

Flags: `--config <path>` (required), `-h, --help`.

Prints the connection target and the local identity:

```text
server:          wss://crh.example.com/agent
node key:        <base64url fingerprint>
server key:      <base64url fingerprint>
privileged mode: forward
```

The `server` line is the derived WebSocket URL, not the `server` value verbatim. `node key` says
`not enrolled (<error>)` when the identity key is missing. The `server key` line is omitted when no
pinned key exists. `privileged mode` is the `[privileged].mode` of the configuration.

**`crha rotate-key`.**

```sh
crha rotate-key
```

Not implemented yet. The command has only `-h, --help` and fails with `crha: not implemented` and
exit code 1. Node-key rotation currently has no online procedure; to replace a lost or compromised
node key, remove `identity.key` and `server.pub`, obtain a new enrollment token and enroll the node
again. See [Rotation and revocation](../../design/protocol.md#rotation-and-revocation).

**`crha upgrade`.**

```sh
crha upgrade --apply /usr/local/bin/crha-new
```

Flags: `--apply <path>` (required), `-h, --help`.

Not implemented yet. With `--apply <path>` the command fails with `crha: not implemented` and exit
code 1; without it, cobra reports the missing required flag. Replace the binary and restart the
service as an ordinary privileged task instead; see
[Reload and upgrade](../../design/execution.md#reload-and-upgrade) and
[Known limitations](../../design/architecture.md#known-limitations).

**`crha version`.**

```sh
crha version
```

Flags: `-h, --help` only.

Prints one line with the build information:

```text
crha 1.0.0 (commit 0123abc, go1.27.3, linux/amd64)
```

The version and commit are set at build time; a development build reports `dev` and `unknown`.

## crha privileged

`crha privileged` groups the two privileged-mode entry points. `run` is the daemon that verifies
authorizations; `stdio` is the helper that native mode starts through sudo, doas or run0.

**`crha privileged run`.**

```sh
crha privileged run --config /etc/crha/privileged.toml
```

Runs the privileged mode: it loads and checks `privileged.toml`, opens the local log, resolves the
privileged task environment, creates the Unix socket and serves forward connections and local
approval until it is stopped.

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--config <path>` | required | Path to `privileged.toml`. |
| `--no-persist-used` | off | Keep the used list in memory only. No file is read or written and `state_dir` is not created. |
| `-h, --help` | | Print usage and exit 0. |
| `--pprof-listen <addr>` | off | Only in a build made with `-tags pprof`: serve Go pprof on `unix:/absolute/path.sock` or a loopback TCP address. |

`--no-persist-used` is for devices with limited disk endurance. It lowers security: after the
privileged mode restarts, a one-shot authorization can run again until its deadline, because the
record that it was used is gone. See [Used list](../../design/privilege.md#used-list).

The socket is created with mode 0660 and the configured group. A stale socket is removed; a
non-socket file at the path is refused. `SIGHUP` reloads the trust configuration; an invalid file
keeps the running one. The process exits 1 if the configuration, the log or the environment cannot
be loaded.

**`crha privileged stdio`.**

```sh
crha privileged stdio
```

The native helper. It reads one task over the `crh-priv` protocol on stdin and writes output and the
result on stdout. It has no command-specific flags, reads no configuration file and accepts no
arguments.

- It refuses to run when stdin is a terminal; it is meant to be started by crha, not typed by a
  person.
- It resolves the privileged task environment (fixed `PATH`, root identity) at start-up; a failure
  fails the helper handshake, and the node's privileged tasks then fail with
  `privileged_unsupported`.
- It executes exactly one task per process and requires the peer's `crha_version` to equal its own.
- It does not verify authorizations. Whoever may run it non-interactively may submit any task, so
  the sudoers or doas rule is the real grant. See [Native mode](../../design/privilege.md#native-mode).
- A task's stdin is staged under `CRHA_PRIVILEGED_STDIN_DIR` (default `/var/lib/crha/privileged`)
  while its size and SHA-256 are checked.

## crha grant

```sh
crha grant --key ~/.ssh/id_ed25519 --payload '<base64 from the WebUI>'
crha grant --key ~/.ssh/id_ed25519 --nodes <node-uuid> --method exec \
  --prefix "systemctl restart " --deadline 1h
```

Signs an authorization with an SSH key and prints it as one base64 line. The signature is an SSHSIG
in the namespace `crh-auth-v1`, produced by `ssh-keygen -Y sign`; crha never reads the private key
itself, so OpenSSH handles encrypted keys, ssh-agent and FIDO touches. The printed line is what the
WebUI accepts at `POST /api/authorizations`. See
[Signing methods](../../design/privilege.md#signing-methods).

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--payload <base64>` | none | Sign the payload of a WebUI authorization request instead of building one from flags. |
| `--nodes <uuid,...>` | none | Node or node group UUIDs the authorization is addressed to, or `*`. Required without `--payload`. |
| `--method <name>` | none | `exec`, `file.read` or `file.write`. Required unless `--any-command` is given. |
| `--exact <target>` | none | Allow exactly this target. Requires `--spec-sha256`. Mutually exclusive with `--prefix`. |
| `--spec-sha256 <hex>` | none | The 32-byte SHA-256 of the complete task spec, as 64 hex characters. Requires `--exact`. |
| `--prefix <target>` | none | Allow every target that starts with this string. Mutually exclusive with `--exact`. |
| `--any-command` | off | Do not restrict the method and target. Cannot be combined with `--method`, `--exact`, `--prefix` or `--spec-sha256`. |
| `--deadline <value>` | none | Required without `--payload`: a positive Go duration (`24h`) or an RFC 3339 time in the future. |
| `--task <id>` | none | Bind the authorization to a task id; repeatable. Makes it one-shot. |
| `--attempt <n>` | 1 with `--task` | Task attempt to bind. Only allowed with `--task`. |
| `--note <text>` | empty | Note shown with the authorization; it is part of the signed payload. |
| `--key <path>` | none | Path to the signing key. Required. A private key or a public key whose private half is loaded in ssh-agent both work. |
| `--yes` | off | Do not ask for confirmation. |
| `-h, --help` | | Print usage and exit 0. |

With `--payload`, none of the payload-building flags may be given: `--nodes`, `--method`, `--exact`,
`--prefix`, `--spec-sha256`, `--any-command`, `--deadline`, `--task`, `--attempt` and `--note` are
all refused. The decoded payload must already carry a deadline and a valid one-shot node/task
pairing.

Without `--payload`, the command validates the flags before it shows anything:

- `--nodes` is required and accepts only canonical lowercase UUIDs or `*`. `*` must be the only
  entry, duplicates are refused, and names and the old `group:<name>` syntax are refused with a
  message saying so.
- `--deadline` is required. A duration is added to the current time; an RFC 3339 value must be in
  the future. Every authorization carries a deadline.
- `--method` is required unless `--any-command` is given, and it needs `--exact` or `--prefix`.
- `--exact` and `--spec-sha256` must be given together.
- `--task` needs exactly one node UUID in `--nodes` per task id, in the same order. A node group or
  `*` cannot stand for a node in a one-shot authorization. `--attempt` needs `--task`; its default
  is 1.

The payload is printed to stderr as indented JSON with `nodes`, `command`, `issued_at`, `deadline`,
`task_ids`, `attempt`, `note` and `authorization_id`. A prefix that does not end in a space or `/`
gets a warning that it also matches longer words. Unless `--yes` is given, the command asks
`Sign this authorization? [y/N]` on the controlling terminal; without a terminal it refuses rather
than sign something the user has not seen.

After signing, the command verifies the signature locally and checks that `--key` holds the key that
signed. The base64 authorization goes to stdout; the signer's key type and fingerprint and a paste
hint go to stderr. A failed `ssh-keygen`, a missing `ssh-keygen`, or a key file that does not match
the signature ends the command with exit code 1.

## crha pending, approve and deny

These three commands talk directly to the privileged mode's socket with the `local` role of
`crh-priv`. The peer uid from `SO_PEERCRED` must appear in the `uids` of a `local` trust entry, or
the connection is refused. They do not go through crhs and need no key. See
[Local approval](../../design/privilege.md#local-approval).

Socket selection, in order:

1. `--socket <path>`, when given (an explicitly empty value is used as given).
2. `CRHA_PRIVILEGED_SOCKET`, when non-empty.
3. `/run/crha/privileged.sock`.

| Command | Arguments |
|---|---|
| `crha pending` | none |
| `crha approve <task-id>` | exactly one task id |
| `crha deny <task-id>` | exactly one task id |

| Flag | Commands | Default | Meaning |
|---|---|---|---|
| `--socket <path>` | all three | `$CRHA_PRIVILEGED_SOCKET`, else `/run/crha/privileged.sock` | Socket to connect to. The full precedence is above. |
| `--attempt <n>` | `approve`, `deny` | 0, meaning the highest pending attempt | Decide this attempt instead of the highest pending one. |
| `--message <text>` | `deny` | empty | Reason recorded with the denial and shown to crhs and the user. |
| `--yes` | `approve`, `deny` | off | Do not ask for confirmation on the terminal. |
| `-h, --help` | all three | | Print usage and exit 0. |

`crha pending` prints every waiting task:

```text
task 0192f000-0000-7000-8000-000000000010 attempt 1 (received 2026-01-01T12:00:00.000Z, note "restart nginx")
{ … complete specification as JSON, including spec_sha256 … }
```

With no waiting task it prints `no tasks are pending local approval`.

`crha approve` and `crha deny` show the complete specification of the chosen task, including the
method, target, argv, environment, working directory, stdin or content size and hash, previews, file
mode, owner, overwrite and edits, plus the `spec_sha256`. They then ask for confirmation on the
terminal unless `--yes` is given. Without `--attempt`, the highest pending attempt of the task is
chosen. The decision is sent with the `spec_sha256` that was shown, so the privileged mode refuses
it if the pending specification changed in the meantime. `--message` on `deny` records a reason that
crhs and the user see.

Success prints `approved task <id> attempt <n>` or `denied task <id> attempt <n>`. There is no
pending request for the task, no terminal to confirm on, or the privileged mode rejects the hash:
the command exits 1 with the reason.

## Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `CRHA_TASK_HOME` | `crha run`, `crha privileged run`, `crha privileged stdio` | Replaces the `HOME` of the task environment. |
| `CRHA_TASK_USER` | same | Replaces `USER`. |
| `CRHA_TASK_LOGNAME` | same | Replaces `LOGNAME`. |
| `CRHA_TASK_SHELL` | same | Replaces the discovered `sh`; must be an absolute path to an existing executable. A bad value stops `crha run` and `crha privileged run` and fails the helper handshake. It also runs `shell` tasks. |
| `CRHA_PRIVILEGED_SOCKET` | `crha pending`, `crha approve`, `crha deny` | Default socket for local approval when `--socket` is not given. |
| `CRHA_PRIVILEGED_STDIN_DIR` | `crha privileged stdio` | Directory for staging a task's stdin while its size and SHA-256 are verified. Default `/var/lib/crha/privileged`. sudo needs `env_keep` to pass it through. |
| `RE2_DOWNLOAD_MIRROR` | server installation (`pnpm install`) | Mirror for the native `re2` module's prebuilt binary when the default download is unavailable. It is not read at runtime. |

All variables whose names start with `CRHA_TASK_` are crha's own and never reach a task; a task that
declares one has it dropped. See [The exec environment](../../design/execution.md#the-exec-environment)
and [crha.toml](crha-config.md#environment-overrides).

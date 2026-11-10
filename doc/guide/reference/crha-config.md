# crha configuration reference

`crha run` reads one TOML file, `crha.toml`, named with `--config`. This page lists every key, its
default and its validation, and describes the reload behaviour and the environment variables that
override parts of it. The privileged mode has its own file; see
[privileged.toml](privileged-config.md).

## Configuration file

`--config <path>` is required by every command that needs a configuration: `crha run`,
`crha enroll` and `crha status`. `crha privileged run` uses its own `--config` and a different file
format; `crha privileged stdio` reads no file at all. crha has no built-in configuration path, so the
path is always explicit.

The file is TOML and is read when the process starts. `crha run` re-reads it on `SIGHUP`:

- An invalid new file is not applied. The process keeps the running configuration and logs
  `reload failed, keeping the current configuration`.
- A changed `server` or `tls_verify` closes the connection and reconnects.
- A changed `notes` re-reports the node's facts.
- A changed `state_dir`, `clock_warn`, `[output]` or `[privileged]` is accepted into the
  configuration but only takes effect after a restart; the process logs a warning naming those keys.

Unknown keys are errors: the file is decoded strictly, so a misspelled or unsupported key stops the
process at startup instead of being ignored. There is no partial load.

Durations use Go's duration syntax: a decimal number with a unit suffix, and several groups may be
combined (`"90s"`, `"1h30m"`, `"300ms"`). There is no `d` unit, so write days as hours (`"168h"` is
seven days).

`crha enroll` can create the file for you: when `--config` does not exist, `--state-dir <absolute
path>` writes a minimal file containing only `server` and `state_dir`. Without `--state-dir` enroll
fails instead of guessing a path, and when the file already exists, passing `--state-dir` is an
error. The file is written with mode 0644 (before the umask) and its parent directory with mode
0755.

A complete file with every key at its default (commented keys are optional and show the value they
take when omitted):

```toml
# /etc/crha/crha.toml

# crhs base URL. https anywhere; http only for a loopback host.
server = "https://crh.example.com"

# Verify the TLS certificate ("system") or not ("none"). The pinned server key still authenticates crhs.
tls_verify = "system"

# Required, absolute. Holds identity.key, server.pub and the defaults below.
state_dir = "/var/lib/crha"

# Default: <state_dir>/NOTES.md. Absolute when set.
# notes = "/var/lib/crha/NOTES.md"

# Warn when the handshake measures a larger clock offset; "0s" disables the warning.
clock_warn = "60s"

[privileged]
mode = "reject"                  # forward | native | ignore | reject
# socket = "/run/crha/privileged.sock"   # required for mode = "forward"; absolute
native = "sudo"                  # sudo | doas | run0, used by mode = "native"

[output]
# dir = "/var/lib/crha/output"   # default: <state_dir>/output; absolute
max_age = "168h"                 # 7 days
max_total = "1GiB"
```

## Path defaults

crha has no built-in absolute path for its configuration, state, log or socket. These are the only
paths it derives, and each is relative to a path you configured:

| Path | Where it comes from |
|---|---|
| `identity.key` | `<state_dir>/identity.key`; the node identity key created by `crha enroll`, mode 0600. A file accessible by group or others is refused. |
| `server.pub` | `<state_dir>/server.pub`; the pinned crhs public key written by `crha enroll`, mode 0644. |
| `notes` | `<state_dir>/NOTES.md` when `notes` is not set. |
| `[output].dir` | `<state_dir>/output` when `dir` is not set; created with mode 0700 at startup. |

Apart from the native helper's stdin staging directory (`/var/lib/crha/privileged`, overridden by
`CRHA_PRIVILEGED_STDIN_DIR`), the only built-in absolute path in crha belongs to local approval:
`crha pending`, `crha approve` and `crha deny` default to `/run/crha/privileged.sock` when neither
`--socket` nor `CRHA_PRIVILEGED_SOCKET` is given. That path is used only for manual approval on the
node. The `/etc/crha/crha.toml` and `/var/lib/crha` shown in examples are suggestions, not defaults.
See [Configuration and paths](../../design/execution.md#configuration-and-paths).

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `server` | URL string, required | none | Base URL of crhs. The scheme must be `https`, or `http` for a loopback host (`localhost` or a loopback IP); any other scheme, or a URL without a host, is rejected. The WebSocket URL is derived: `https` becomes `wss`, `http` becomes `ws`, `/agent` is appended to the path, and any query or fragment is dropped. A path prefix is kept, so `https://host/crh` connects to `wss://host/crh/agent`. |
| `tls_verify` | `"system"` or `"none"` | `"system"` | `"system"` verifies the TLS certificate normally. `"none"` disables certificate verification; this is useful for a self-signed certificate behind a proxy. The Noise handshake still pins crhs's public key, which `crha enroll` took from the enrollment token, so `"none"` does not trust an unknown server. See [WSS and Noise](../../design/protocol.md#wss-and-noise). |
| `state_dir` | absolute path string, required | none | Directory for the node identity key and the pinned server key. Everything else that is not set explicitly is placed below it. A relative path is rejected. |
| `notes` | absolute path string | `<state_dir>/NOTES.md` | Markdown notes file reported to crhs as `Facts.notesPath`, so an agent can read node notes with ordinary file tools. A relative path is rejected. See [Node notes](../../design/agent-runtime.md#node-notes). |
| `clock_warn` | duration string | `"60s"` | Warn when the offset measured during a crhs handshake is larger than this. `"0s"` disables the warning. A negative value is rejected. The measured offset is diagnostic only; the authorization tolerance is `clock_skew` in [privileged.toml](privileged-config.md#top-level-keys). See [Clock](../../design/privilege.md#clock). |

`server` and `state_dir` are required; every command that loads the file needs them. The node's
identity key is loaded from `state_dir`; if it is missing, `crha run` tells you to run
`crha enroll` first.

## [privileged]

How the unprivileged mode handles a task marked privileged. The setting is reported to crhs and
shown in the WebUI. The full semantics, including who can make a privileged task run in each mode,
are in [Privilege modes](../../design/privilege.md#privilege-modes).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"forward"`, `"native"`, `"ignore"` or `"reject"` | `"reject"` | What to do with a privileged task. A node without a `[privileged]` table rejects them. |
| `socket` | absolute path string | none | The privileged mode's Unix socket. Required when `mode = "forward"`; when set in another mode it is validated but not used. A relative path is rejected. |
| `native` | `"sudo"`, `"doas"` or `"run0"` | `"sudo"` | Escalation tool used by `mode = "native"`. It starts `crha privileged stdio` as the target identity: `sudo -n`, `doas -n`, or `run0 --pipe --no-ask-password`. See [Native mode](../../design/privilege.md#native-mode). |

For `forward`, `socket` must name the same Unix socket that `privileged.toml` configures for
`crha privileged run`. The two files are read by different processes and are not cross-checked, so a
mismatch shows up as a failed forward connection, not as a configuration error.

| `mode` | Behaviour | Who can make a privileged task run |
|---|---|---|
| `forward` | Forwards the task and its authorization unchanged to the privileged mode over the Unix socket. | The privileged mode's trust configuration. |
| `native` | Starts `crha privileged stdio` through the escalation tool and lets it execute the task. | crhs, subject only to crhs policy; this is not a security boundary. |
| `ignore` | Ignores the privileged flag and runs the task as the unprivileged mode's own user. | crhs, subject only to crhs policy. |
| `reject` | Refuses every privileged task. | Nobody. |

`native` is intended for non-interactive escalation, not as a security boundary: whoever may run the
helper without a password may submit any task, so the sudoers or doas rule is the real grant. Use
`forward` when per-command limits are required.

## [output]

The unprivileged mode writes a task's complete output to a file on the node. These settings control
that directory and its cleanup. The output itself is one merged stream; see
[Output](../../design/execution.md#output).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dir` | absolute path string | `<state_dir>/output` | Directory for complete output files, named `<task-uuid>.log` and created with mode 0600. A relative path is rejected. The directory is created with mode 0700 at startup. |
| `max_age` | duration string | `"168h"` (7 days) | Delete output files whose modification time is older than this. Must be positive. |
| `max_total` | size string | `"1GiB"` | Delete the oldest output files until the directory is at most this size. Must be positive. Sizes are an integer with an optional `KiB`, `MiB` or `GiB` suffix; a bare integer means bytes, and `TB`, fractions and negative values are rejected. |

A cleanup sweep runs hourly. It only considers regular files directly in `dir` whose names match
`<uuid>.log`, and it never deletes a file belonging to a task that is still running or whose output
has not yet been acknowledged. Files that are not in use are removed when they are older than
`max_age`; if the directory is still larger than `max_total`, the oldest remaining files are removed
until it fits. The output files are written by the unprivileged mode, including the output of
privileged tasks, which it relays from the privileged mode.

## Environment overrides

crha builds each task's environment instead of passing its own through wholesale. Four variables
override the resolved account and shell, and two more control the local socket and the native
helper. They are read by the process named in the table, at startup (the native helper reads them
each time it is started).

| Variable | Read by | Effect |
|---|---|---|
| `CRHA_TASK_HOME` | `crha run`, `crha privileged run`, `crha privileged stdio` | Replaces the `HOME` of the task environment when non-empty. |
| `CRHA_TASK_USER` | same | Replaces `USER`. |
| `CRHA_TASK_LOGNAME` | same | Replaces `LOGNAME`. |
| `CRHA_TASK_SHELL` | same | Replaces the discovered `sh`. It must be an absolute path to an existing executable; a bad value stops `crha run` and `crha privileged run`, and fails the native helper's handshake. It also selects the shell that runs `shell` tasks. |
| `CRHA_PRIVILEGED_SOCKET` | `crha pending`, `crha approve`, `crha deny` | The socket to connect to when `--socket` is not given. Precedence: `--socket`, then this variable, then `/run/crha/privileged.sock`. |
| `CRHA_PRIVILEGED_STDIN_DIR` | `crha privileged stdio` | Directory in which the native helper stages a task's stdin while it verifies the size and SHA-256. Default `/var/lib/crha/privileged`. sudo needs `env_keep` to pass it through. |

Every variable whose name starts with `CRHA_TASK_` is crha's own and is never passed to a task. A
task that names one in its `env` has it dropped. Apart from `PATH`, crha's own environment is not
passed to a task: the task gets `PATH` (inherited from the crha process in the unprivileged mode, or
the fixed privileged path), `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG` and `LC_ALL`, plus the
variables the task declares. In `forward` mode the privileged mode accepts only names listed in the
trust entry's `env_allow`; the `native` helper has no trust configuration and does not apply that
restriction. See [The exec environment](../../design/execution.md#the-exec-environment) and
[Local approval](../../design/privilege.md#local-approval).

## Unknown keys and errors

The file is decoded with unknown fields disallowed, so an unsupported key stops `crha run`,
`crha enroll` or `crha status` at startup. The message names every unknown key as a dotted path:

```text
config: unknown key: output.nope
config: unknown key: allow_kinds, read_only
```

(The second line is an example of a file with two unknown keys; the message lists every unknown key
in file order.)

A TOML syntax error is reported as `config: parse: ...`. Validation errors name the key and the
reason:

| Input | Message |
|---|---|
| no `server` | `config: server: required` |
| `server = "http://example.com"` | `config: server: http is only allowed for loopback hosts, got "example.com"` |
| `server = "ftp://example.com"` | `config: server: unsupported scheme "ftp" (want https)` |
| `tls_verify = "x"` | `config: tls_verify: invalid value "x" (want system or none)` |
| no `state_dir` | `config: state_dir: required` |
| `state_dir = "x"` | `config: state_dir: path "x" must be absolute` |
| `notes = "n.md"` | `config: notes: path "n.md" must be absolute` |
| `[privileged] mode = "x"` | `config: privileged.mode: invalid value "x"` |
| `[privileged] mode = "forward"` without `socket` | `config: privileged.socket: required when privileged.mode = "forward"` |
| `[privileged] socket = "s"` | `config: privileged.socket: path "s" must be absolute` |
| `[privileged] native = "su"` | `config: privileged.native: invalid value "su" (want sudo, doas or run0)` |
| `clock_warn = "x"` | `config: clock_warn: ...` |
| `clock_warn = "-1s"` | `config: clock_warn: must not be negative` |
| `[output] dir = "o"` | `config: output.dir: path "o" must be absolute` |
| `[output] max_age = "0s"` | `config: output.max_age: must be positive` |
| `[output] max_total = "1TB"` | `config: output.max_total: invalid size "1TB"` |

Two groups of keys do not exist and are rejected as unknown keys rather than accepted and ignored:

- **Local policy keys.** There is no node-local policy in crha. `allow_kinds` and `read_only` are
  not read, not validated and not enforced; a file containing them fails to load with
  `config: unknown key: allow_kinds, read_only`. The server's rules and the privileged mode's trust
  configuration are the only policy layers. See
  [Known limitations](../../design/architecture.md#known-limitations).
- **Node groups.** `groups` is not a crha key. Node groups exist only in crhs; a node's trust
  aliases are configured in [privileged.toml](privileged-config.md#top-level-keys).

A missing file is reported as `config: read <path>: ...`; `crha run` does not create it.

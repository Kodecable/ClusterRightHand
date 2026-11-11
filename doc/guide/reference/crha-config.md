# crha configuration reference

`crha.toml` configures the unprivileged mode (`crha run`). The privileged mode has its own file,
[`privileged.toml`](privileged-config.md).

## Configuration file

`crha run`, `crha enroll` and `crha status` require `--config <path>`; crha has no default
configuration path. If the file does not exist, `crha enroll --state-dir <dir>` creates a minimal one.

`crha run` re-reads the file on `SIGHUP`. A file that fails to load is not applied. Changes to `server`,
`tls_verify` and `notes` take effect immediately; other changes need a restart, and crha logs which.

Durations use Go syntax, such as `"90s"` or `"1h30m"`. There is no day unit: write seven days as
`"168h"`.

Every key with its default:

```toml
server = "https://crh.example.com"      # required
tls_verify = "system"
state_dir = "/var/lib/crha"             # required
# notes = "/var/lib/crha/NOTES.md"      # default: <state_dir>/NOTES.md
clock_warn = "60s"

[privileged]
mode = "reject"
# socket = "/run/crha/privileged.sock"  # required for mode = "forward"
native = "sudo"

[output]
# dir = "/var/lib/crha/output"          # default: <state_dir>/output
max_age = "168h"
max_total = "1GiB"
```

## Path defaults

All paths must be absolute. Files that crha keeps in `state_dir`:

| File | Content |
|---|---|
| `identity.key` | The node's private key, created by `crha enroll` (mode 0600) |
| `server.pub` | crhs's public key, pinned by `crha enroll` |
| `NOTES.md` | Node notes, unless `notes` is set |
| `output/` | Complete task output, unless `[output].dir` is set |

The only built-in absolute path is the local approval socket used by `crha pending`, `crha approve`
and `crha deny`: `/run/crha/privileged.sock`, unless `--socket` or `CRHA_PRIVILEGED_SOCKET` says
otherwise.

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `server` | URL | required | crhs's base URL. `https`, or `http` only for localhost. A path prefix is allowed. |
| `tls_verify` | `"system"` or `"none"` | `"system"` | Whether to verify crhs's TLS certificate. `"none"` is safe with a self-signed certificate, because crha still checks crhs's pinned key. |
| `state_dir` | path | required | Directory for the node's keys and default paths. |
| `notes` | path | `<state_dir>/NOTES.md` | The node notes file that agents read and edit. |
| `clock_warn` | duration | `"60s"` | Warn when the node's clock differs from crhs's by more than this. `"0s"` disables the warning. |

## [privileged]

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"forward"`, `"native"`, `"ignore"` or `"reject"` | `"reject"` | How to handle privileged tasks ([choosing a mode](../security.md#choosing-a-privilege-mode)). |
| `socket` | path | none | The privileged mode's socket; required for `forward`, and must match `socket` in `privileged.toml`. |
| `native` | `"sudo"`, `"doas"` or `"run0"` | `"sudo"` | Escalation tool for `native` mode. `run0` is experimental. |

For `native`, the crha user must be allowed to run `crha privileged stdio` as the target user without a
password, for example in sudoers:

```text
crha ALL=(root) NOPASSWD: /usr/local/bin/crha privileged stdio
```

## [output]

crha keeps each task's complete output in a file, readable only by the crha user.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dir` | path | `<state_dir>/output` | Directory for output files. |
| `max_age` | duration | `"168h"` | Delete output files older than this. |
| `max_total` | size | `"1GiB"` | Delete the oldest output files beyond this total. Sizes are bytes or use `KiB`, `MiB`, `GiB`. |

Cleanup runs hourly and never removes output that crhs has not yet received.

## Environment overrides

Tasks do not inherit crha's environment. They get `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, a UTF-8
locale, and the variables the task sets. These variables, set for the crha process, change the task
defaults:

| Variable | Effect |
|---|---|
| `CRHA_TASK_HOME`, `CRHA_TASK_USER`, `CRHA_TASK_LOGNAME` | Override the account variables, for accounts not listed in `/etc/passwd` (crha does not use NSS). |
| `CRHA_TASK_SHELL` | The shell for shell commands; an absolute path to an executable. |
| `CRHA_PRIVILEGED_SOCKET` | The socket for `crha pending`, `approve` and `deny`. |
| `CRHA_PRIVILEGED_STDIN_DIR` | Where the `native` helper stages task input (default `/var/lib/crha/privileged`). |

For `native` mode, sudo drops these variables unless sudoers keeps them (`env_keep += "CRHA_TASK_*"`).
Tasks cannot set `CRHA_TASK_*` variables themselves.

## Unknown keys and errors

Unknown keys are errors; crha prints `config: unknown key: <key>` and does not start. crha has no
node-local policy keys and no `groups` key: node groups exist only in crhs, and a node's trust aliases
are set in `privileged.toml`.

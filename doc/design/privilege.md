# Privilege and authorization

A privileged task is a task that a node executes only after it has verified an authorization. The
authorization is issued by crhs, by the task's owner, or locally on the node, and the node's
privileged mode makes the final decision. This document describes the modes, the authorization and
trust objects, the validation the node performs, and how crhs plans a path. The wire formats of the
privilege messages are in [Privilege messages](protocol.md#privilege-messages); this document keeps
the semantics.

## Terminology

| Term | Meaning |
|---|---|
| crha unprivileged mode | The crha instance that connects to the network and talks to crhs. Ordinary tasks run under its own Linux identity. |
| crha privileged mode | The crha instance that does not use the network and serves the unprivileged mode over a local unix socket. It executes only tasks with a valid authorization, under its own Linux identity. |
| Privileged task | A task whose spec has `privileged = true`. It needs the authorization path. |
| Trust alias | An entry of `aliases` in `privileged.toml`: a UUID that the node accepts as its own address. An authorization is addressed to the node when its payload `nodes` contains the node's `node_id` or any alias. An alias is not a node group; it is a UUID list configured by the node's root. |

**The modes are decoupled from the Linux user identity.** "Privileged" means "needs an
authorization to execute", not "runs as root":

- A common deployment runs the unprivileged mode as an ordinary user and the privileged mode as
  root.
- The unprivileged mode may also run as root, for example together with the `ignore` mode described
  below.
- The privileged mode may run as another user. Running it as `deploy`, for example, makes "execute
  as deploy" an operation that needs an authorization.

Both modes are the same binary, started as two processes (usually by systemd). To crhs they are one
node.

## Threat model and scope

| Concern | How it is handled |
|---|---|
| Compromised crhs | On a node that trusts only users, crhs cannot execute a privileged task alone. |
| Network attacker | Protected by the Noise channel between crhs and crha; see [Transport security](protocol.md#transport-security). |
| Prompt injection, agent overreach, a stolen API token | Constrained by crhs policy and by the privileged mode's trust configuration. |

**Threats inside the host are out of scope**: other local users or processes attacking the
privileged mode, and forgery by a compromised unprivileged mode. Therefore:

- The privileged mode has no identity key, and the unix socket between the two modes is not
  encrypted.
- The trust report that the privileged mode returns is not signed.

A forged request from the unprivileged mode still cannot make the privileged mode execute anything
without a valid authorization. Protecting the socket would add keys and failure modes without
addressing the stated threats, because an attacker who can act inside the host already controls
more than the socket.

## Privilege modes

The mode is set in the unprivileged mode's configuration, reported in `Hello`, and shown by crhs.
The run identity of each mode is reported in the trust summary ([Trust summary](protocol.md#trust-summary)).

```toml
# crha run --config /etc/crha/crha.toml (unprivileged mode; the paths are examples, not built-in defaults)
state_dir = "/var/lib/crha"                # required: root of the identity key, notes and output

[privileged]
mode   = "forward"                         # forward | native | ignore | reject
socket = "/run/crha/privileged.sock"       # required when mode = "forward"; unused otherwise
native = "sudo"                            # used when mode = "native": sudo | doas | run0; default sudo
```

| Mode | Behaviour | Who can make a privileged task run |
|---|---|---|
| `forward` | Forwards the task to the privileged mode | Decided by the privileged mode's trust configuration |
| `native` | Starts `crha privileged stdio` temporarily with `sudo -n` / `doas -n`, and that helper executes the task | crhs, constrained only by crhs policy |
| `ignore` | Ignores the privileged flag and runs the task under the unprivileged mode's own identity | crhs, constrained only by crhs policy |
| `reject` | Rejects every privileged task | Nobody |

The default mode is `reject`, so a node with no `[privileged]` table rejects every privileged task.

- `native` exists to obtain the target identity non-interactively. It is **not a security
  boundary**: permission to call the helper without a password is equivalent to crhs already having
  the target identity.
- `ignore` is common when the unprivileged mode itself runs as root; in that deployment it is
  equivalent to crhs having root.
- The real security boundary is `forward`.

### Native mode

`native` does not run `sudo -n -- argv` directly. It starts the same binary (the absolute path
resolved from `os.Executable()`) as a helper, `crha privileged stdio`. The helper runs `exec` and
`file.*` under the target identity and shares the executor and the `crh-priv` protocol with the
privileged mode ([crh-priv](protocol.md#crh-priv)), but it does not check authorizations. Starting
the helper instead of the final command is necessary because:

- Once the target process runs as root, the unprivileged process may not signal it: `kill(2)`
  checks the uid and returns `EPERM`. sudo and opendoas (the PAM version on Ubuntu) fork the target
  process and forward SIGTERM, but a SIGKILL sent to sudo or doas leaves the root process orphaned
  and running. Cancellation and timeout must be handled by a helper that has the same privilege.
- sudo 1.9.14+ defaults to `use_pty`, but only while sudo has a terminal. crha runs as a service
  without a controlling terminal, so the output remains three independent pipes. `env_reset` also
  prevents an environment allowlist from being passed through unchanged.
- crha therefore cancels a task only through the `crh-priv` protocol and never signals the helper.
  When crha is killed, the helper reads EOF on stdin and treats it as a disconnect: the current task
  runs to completion, writes the local log and exits.
- `file.*` needs the target identity too; running the final argv directly cannot provide it.

The cost is that sudoers sees only `crha privileged stdio` and cannot restrict the final command;
sudo's command log also shows only the helper. The helper writes each task's complete spec to the
local log and to journald. Use `forward` when per-command limits are required.

Sudoers and doas examples:

```text
crha ALL=(root) NOPASSWD: /usr/bin/crha privileged stdio
permit nopass crha as root cmd /usr/bin/crha args privileged stdio
```

- When the escalation tool fails (a password is required, no rule is configured, or the helper and
  the unprivileged mode have different versions), the task fails with `privileged_unsupported` and
  a message that explains why. It never falls back to unprivileged execution.
- `run0` is an experimental backend: it needs systemd 257+ (`run0 --pipe`; the systemd 255 in
  Ubuntu 24.04 has no run0), polkit rules cannot simply allow
  `org.freedesktop.systemd1.manage-units`, and cancellation and disconnect need separate
  verification.
- The helper runs exactly one task per process, refuses to start when its stdin is a terminal, and
  refuses a handshake whose `crha_version` differs from its own ([crh-priv](protocol.md#crh-priv)).

## The privileged mode

```text
crha unprivileged mode (network)
   │  unix socket: privileged.toml's socket (example /run/crha/privileged.sock; group crha, mode 0660)
   │  the privileged mode distinguishes peers with SO_PEERCRED: unprivileged_uid submits tasks,
   │  a uid in a local trust entry approves locally
   ▼
crha privileged mode (no network)
   ├── configuration: privileged.toml from crha privileged run --config (example /etc/crha/privileged.toml;
   │   owned by the privileged mode's user, not writable by other users)
   ├── used list: used under state_dir (example /var/lib/crha/privileged/used)
   └── local log: the jsonl file named by log (example /var/log/crha/privileged.jsonl) + journald
```

- The unprivileged mode forwards a privileged task with its authorization unchanged. The privileged
  mode verifies it, executes the task, and relays the output over the socket.
- The privileged mode accepts at most 8 `forward` connections. A handshake beyond the limit is
  rejected and the connection is closed.
- Every frame write has a 10-second deadline. A peer that stops reading times out on that frame and
  its connection is closed.
- `trust.summary` and `local.decision` are queued per connection and sent by that connection's own
  writer, so `crha approve` and a SIGHUP reload do not block on a connection that does not read, and
  a reload does not make the Run loop ignore SIGTERM.
- **Editing the trust configuration is itself a privileged task**: a `file.write` on
  `privileged.toml`, followed by SIGHUP to the privileged process. The path comes from the
  configuration. The edit needs an authorization from an existing trust entry, so crhs cannot bypass
  it. The recommended crhs trust entry denies `file.write /etc/crha/`, which leaves the trust
  configuration to a user authorization or to a local edit on the node.
- The privileged mode has no identity key, and the socket is not encrypted; see [Threat model and
  scope](#threat-model-and-scope).
- Each process reloads only its own file on SIGHUP: `crha privileged run` re-reads
  `privileged.toml`, and `crha run` re-reads `crha.toml`. A file that does not load keeps the
  running configuration and logs the error.

## Methods and targets

Every task has one **method** and one normalized **target**. An authorization's command limit and a
trust entry's guard rules both match a method and a target.

| Method | Tasks it covers | Target |
|---|---|---|
| `exec` | `exec` | The rendered argv: an argument that contains a character outside `[A-Za-z0-9_@%+=:,./-]` is wrapped in POSIX single quotes (an inner `'` becomes `'\''`), and the arguments are joined with one space. A shell-mode task renders as the argv `["/bin/sh", "-c", script]`. |
| `file.read` | `file.read`, `file.stat`, `file.list` | The absolute path. |
| `file.write` | `file.write`, `file.edit`, **and every `file.read` ability** | The absolute path. |

- The argv rendering is canonical, so a later argument cannot pretend to be part of an earlier one.
  A shell-mode target starts with `/bin/sh -c`, so a rule such as `prefix = "systemctl restart "`
  does not match shell mode, and `;`, `&&` or `$()` cannot bypass it. Allowing shell scripts
  requires an explicit rule that targets `/bin/sh -c`.
- A privileged file path must be absolute and already normalized: no `.` or `..` component and no
  repeated `/`. No component may be a symbolic link. The path is opened with
  `openat2(RESOLVE_NO_SYMLINKS)`, and anything else is refused. A symlink is only discovered when
  the path is opened, so this check happens after acceptance: the task ends with `error` and code
  `symlink_not_allowed`, not as a retryable authorization rejection, because a different signer
  would not make the path safe. Without this rule, `/etc/nginx/x` could be a link to `/etc/shadow`
  and bypass every path-based rule.
  - Resolution starts at a directory fd for `/` and opens the path relative to it with
    `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`. Later stat, read and list operations use the returned
    fd and do not resolve the path again.
  - A write opens the parent directory the same way, creates a temporary file under the parent fd,
    writes it, and publishes it with `renameat2` (with `RENAME_NOREPLACE` when `overwrite = false`).
  - **Fail closed**: `openat2` returning `ENOSYS` (a kernel before 5.6) or `EPERM` (seccomp) refuses
    the privileged file operation with `openat2_unavailable` and a message that the environment is
    unsupported. There is no fallback to `lstat` and `open`.
  - `RESOLVE_NO_SYMLINKS` does not stop hard links or bind mounts. A directory that a rule allows
    should be writable only by the target identity.
  - Reads and edits accept regular files only: the path is opened with `O_PATH` and fstat'ed (the
    unprivileged mode stats first), and only a regular file is then opened for reading. Character
    and block devices, FIFOs, sockets and directories are refused with `not_regular_file`, so
    opening a device has no side effect and a FIFO with no writer does not block forever. Reads are
    opened non-blocking.
  - A `file.write` keeps the setuid, setgid and sticky bits of `mode`. A `prefix` authorization and
    guard rules do not constrain `mode` or `owner`; use `exact` when they must be constrained.

## Authorizations

An authorization is a body, an optional command limit and a deadline. **`deadline` is mandatory**: a
node refuses an authorization without one as `authorization_expired` at step 4 of the [validation
flow](#validation-flow), and crhs refuses to accept one (400). `crha grant` requires `--deadline`
and refuses to sign a payload that has none. A signed authorization without an expiry could be used
forever, and there is no revocation mechanism to withdraw it ([Revoking trust](#revoking-trust)).

The body is a CBOR payload, and signatures and cosignatures are entries of one `signatures` array on
the same object. The encoding and the signature forms are in [Authorization
object](protocol.md#authorization-object); the fields mean:

- `v`: payload version, `1`.
- `nodes`: node UUIDs, node-group UUIDs, or exactly `["*"]` (every node that trusts the signer). It
  must not be empty. Names are only input and display and are resolved to UUIDs before signing, so
  renaming a node or a node group does not affect an issued authorization.
- `command`: `null` for any method and any target, otherwise a method with an `exact` or `prefix`
  match.
- `issued_at_ms` and `deadline_ms`: Unix milliseconds. The difference is bounded by the trust
  entry's `max_ttl` when it sets one.
- `task_ids` and `attempt`: both `null` for a reusable authorization, or both set for a one-shot
  authorization.
- `note`: human-readable text inside the signature; the empty string when there is no note.

- **The authorization id** is `SHA-256(payload)` over the original payload bytes. It identifies the
  authorization in the used list, the audit log and references.
- A user signature and a crhs cosignature sign the **same CBOR payload**. There is no second
  payload, so the two can never disagree about the nodes, command, spec hash, task ids, attempt or
  deadline.
- `require-cosign` requires a valid user signature and a `role = "crhs"` cosignature on the same
  object.
- **Addressed to a node**: an authorization is addressed to the node when `nodes` contains the
  node's `node_id` or any of its trust aliases. The aliases are configured by the node's root and
  crhs cannot change them; they usually hold the UUIDs of the node groups the node belongs to.
  crhs-side node groups are crhs data and do not decide which authorizations a node accepts.
- **A one-shot authorization covering several nodes** (a task group): the task group creates one
  task per node; the payload's `task_ids` lists all task ids, and `nodes` lists the corresponding
  node UUIDs. A one-shot authorization may contain only node UUIDs, and crhs expands a node group
  into node UUIDs when signing, so the coverage does not change when group membership changes later.
  Every node's `task.start` carries the same authorization object, so the user signs once.
  `nodes` and `task_ids` correspond position by position ([Authorization
  object](protocol.md#authorization-object)), and the privileged mode accepts only the task id that
  belongs to it, so a compromised crhs cannot send another node's task id to the same node and
  execute it again. When some nodes are refused before acceptance, crhs builds a new payload for
  those nodes only (`attempt + 1`, with `task_ids` reduced to the refused nodes); the user signs
  again, and nodes that already executed are not affected.
- **`exact`**: the method and the target are equal, and `spec_sha256` must equal the hash of the
  complete task spec, `SHA-256(CBOR(TaskSpec))` ([Authorization
  object](protocol.md#authorization-object)). The complete spec includes the environment, cwd and
  the stdin hash; a file write also includes the content hash, mode, owner and `overwrite`; a file
  edit includes every `edits` entry. Approving "write `/etc/nginx/nginx.conf`" therefore approves
  that content, and approving an edit approves those replacements, not arbitrary content. The nodes
  of a task group use the same spec and share one `spec_sha256`.
- **`prefix`**: the method matches (`file.write` includes `file.read`) and the target starts with
  the prefix. It constrains only the target, not stdin or the written content. cwd is `/`, and the
  environment is constrained by the trust entry's `env_allow`.
- **`task_ids` (one-shot)**: the authorization is valid only for the listed task ids, and `attempt`
  must equal the `attempt` of `task.start`. Before executing, the privileged mode records
  `(authorization id, task id)` and the task id in its local used list ([Used
  list](#used-list)), persisting the record first. The same authorization cannot be used twice on
  the same task, and the same task id cannot execute twice.
- `exact` constrains what executes, not how many times. An authorization without `task_ids` is
  reusable until its deadline, deliberately: scheduled tasks and pre-issued `crha grant`
  authorizations rely on it.
- A crhs single-command authorization is `exact` + `task_ids` + a short `deadline`. The privileged
  mode forces `task_ids` on every `role = "crhs"` authorization and on every cosignature;
  `require_exact` and `max_ttl` come from the crhs trust entry.
- A user approving a specific task (a Passkey in the WebUI, or `crha grant --payload`) also issues
  an authorization with `task_ids`, so it is one-shot.
- A scheduled task's authorization has the same structure: `exact` + `deadline`, without `task_ids`,
  so every trigger can use it. The privileged mode does not check the schedule time, so whoever
  holds the authorization can use it at any time before the deadline. Per-trigger constraint needs a
  cosignature, and because a cosignature requires `task_ids`, each trigger then needs a new payload.

### One-shot authorizations

A one-shot authorization lists `task_ids`, and `attempt` must equal the `attempt` of `task.start`.
The key of the used list is `(authorization id, task id)`: one authorization is consumed once per
task, and a task id runs once.

- For a task group, the payload binds each task id to its node position by position. The privileged
  mode accepts only the pair that names it, so one shared authorization object is safe across the
  nodes of the group.
- crhs-issued authorizations and all cosignatures are always one-shot: the privileged mode requires
  `task_ids` on `role = "crhs"` authorizations, and a cosignature is a signature on a payload that
  already carries them.
- A user trust entry with `require_task` accepts only one-shot authorizations; `require_task` has no
  effect on a crhs entry because crhs authorizations always carry `task_ids`.
- The used record is persisted before the task starts, so a crash cannot lose the fact that an
  authorization was used.

### Used list

The privileged mode records every executed task in `state_dir/used`, a JSON-lines file (example
`/var/lib/crha/privileged/used`). Each line holds the task id, attempt, the spec hash and the
acceptance time; a record with an authorization also holds the authorization id, `issued_at_ms` and
`deadline_ms`. A line is appended and fsync'ed before the task starts.

- **Retention**: a record with an authorization and a `deadline` is kept until
  `deadline + max(1h, clock_skew)`. An authorization may still be accepted until
  `deadline + clock_skew`, and the one-hour floor leaves room for a clock that steps back. A local
  approval (no authorization) and a record without a deadline are kept for 24 hours after
  acceptance.
- **Cap**: at most 8192 records in memory. Before an append, expired records are dropped and the
  oldest records are evicted in acceptance order until the new record fits.
- **Watermark**: when an evicted record's authorization is still acceptable (`now ≤ deadline +
  clock_skew`), the in-memory watermark is raised to that record's `issued_at`. An authorization
  issued at or before the watermark is refused with `authorization_rejected` and must be signed
  again, so eviction cannot make a one-shot authorization usable again. The watermark is not
  written to the file: after a restart it is rebuilt from the records that remain, and a record that
  was both evicted and compacted away leaves no watermark, so its authorization may execute again
  before its deadline. That is a deliberate trade-off.
- **File**: append-only. When the line count reaches `2 × max(live records, 1024)`, the live records
  are rewritten through a temporary file with fsync and rename, and the file is reopened. The file
  therefore stays at about `2 × max(live records, 1024)` lines and the rewrite cost is amortized. At
  startup the list is loaded, the retention and cap rules are applied, and the file is rewritten
  once.
- **`--no-persist-used`**: `crha privileged run --no-persist-used` keeps the list in memory only. It
  reads and writes no file and creates no directory, which suits embedded devices with limited
  flash write endurance. The cost is that a one-shot authorization may execute again before its
  deadline after the privileged mode restarts.

### Signing methods

| Signer | Format | What is signed | Where it is signed |
|---|---|---|---|
| crhs | SSHSIG (`ssh-ed25519`, namespace `crh-auth-v1`, hash sha512) | The original payload bytes | Inside crhs: `node:crypto` ed25519 with a hand-written SSHSIG wrapper; the private key is encrypted with the master key |
| User SSH key | SSHSIG (same; supports `ssh-ed25519`, `sk-ssh-ed25519@openssh.com`, `ecdsa-sha2-nistp256` and their `sk-` versions) | The original payload bytes | On the user's workstation: `crha grant` (which calls `ssh-keygen -Y sign`), or `ssh-keygen -Y sign -n crh-auth-v1` directly |
| User Passkey | WebAuthn assertion | `challenge = SHA-256("crh-auth-v1\0" ‖ payload)` | The WebUI |

- Canonicalization is `CBOR-CORE-INT-v1` (RFC 8949 §4.2.1: shortest integers, no indefinite length,
  no floats or tags, times as integer milliseconds).
- The implementations use standard libraries: `x/crypto/ssh` and a hand-written SSHSIG codec plus
  hand-written WebAuthn verification in crha; `node:crypto` and a hand-written SSHSIG wrapper in
  crhs; `@simplewebauthn/server` for registration and assertion verification in crhs.
- The SSHSIG message is the original payload. SSHSIG hashes it itself, so the signer does not
  pre-hash. Every SSHSIG authorization can be checked by hand with `ssh-keygen -Y verify`.
- `sk-*` signatures: `x/crypto/ssh` verifies the signature and requires the UP (user presence) flag.
  The counter is not compared across authorizations; replay prevention is the used list. A trust
  entry can require the UV flag with `require_uv`, and the privileged mode checks the flags it
  extracts from the signature.
- **`crha grant`** does not read the private key. It passes the payload bytes on stdin to
  `ssh-keygen -Y sign -n crh-auth-v1 -f <key>`, where `<key>` is a private key or the public key of
  a key loaded in an agent, so OpenSSH handles encrypted keys, agents, and FIDO touch and PIN. It
  has two forms:
  - `crha grant --payload <base64>` signs the payload of a WebUI authorization request. The CBOR is
    decoded to JSON and shown, and the user confirms before signing.
  - `crha grant --nodes <UUID,…|*> --method … --prefix … --deadline …` builds a reusable
    authorization from the arguments. `--nodes` accepts node UUIDs, node-group UUIDs or `*`, never
    names, because crha does not know names.
  Both forms print an `Authorization` as base64, which the user pastes into the WebUI
  (`POST /api/authorizations`). The WebUI also shows the equivalent `ssh-keygen` command.
- WebAuthn checks: `type = webauthn.get`, the challenge, an origin in the trust entry's allowlist
  (cross-origin is denied by default), the rpIdHash, the UP flag (UV can be made mandatory), the
  `credential_id` against the trust entry's COSE public key, and the signature (ES256, EdDSA or
  RS256, over `authenticator_data ‖ SHA-256(client_data_json)`). The signature counter is ignored
  because a synchronized passkey always reports 0; replay prevention is the used list. crhs
  registers only these three algorithms (`supportedAlgorithmIDs: [-7, -8, -257]`), so a credential
  that the privileged mode cannot verify cannot be registered.
- Trusting a Passkey accepts a specific risk: the page that shows the authorization is served by
  crhs, so a compromised crhs can induce the user to sign an authorization that differs from what
  the page displays. A Passkey gives no protection in that case, and the trust configuration does
  not treat a Passkey entry as a stronger signer than an SSH-key entry.

## Trust configuration

All trust entries live in one array. `role` distinguishes the signer, and `format` distinguishes the
signature form:

| `role` | Available `format` | Available `kinds` | Meaning |
|---|---|---|---|
| `crhs` | `sshsig` | `execute`, `cosign` | crhs's authorization signing key |
| `user` | `sshsig`, `webauthn` | `execute`, `require-cosign` | A user's SSH key, FIDO hardware key or Passkey |
| `local` | none (uses `uids`) | `execute` | Local approval with `crha approve` on the node |

| `kind` | Meaning |
|---|---|
| `execute` | May authorize a privileged task alone |
| `cosign` | May add a cosignature to a user authorization that requires one |
| `require-cosign` | Every use of this user's authorization needs a cosignature |

A cosignature can only come from a `role = "crhs"` entry whose `kinds` contain `cosign`, so users
cosigning each other is structurally impossible. crhs's `execute` and `cosign` are independent
capabilities, and either can be granted alone:

| crhs entry `kinds` | Effect |
|---|---|
| `["execute", "cosign"]` | crhs may authorize alone and may cosign |
| `["cosign"]` | crhs may not authorize alone; it may only cosign user authorizations that require it |
| no crhs entry | crhs takes no part in privileged tasks |

```toml
# crha privileged run --config /etc/crha/privileged.toml (the paths are examples)
node_id          = "0192f000-0000-7000-8000-000000000001"      # canonical lowercase UUID
aliases          = ["0192f000-0000-7000-8000-0000000000a1"]      # trust aliases; usually the node's node group UUIDs
unprivileged_uid = 998
socket           = "/run/crha/privileged.sock"
socket_group     = "crha"                    # group of the socket; default crha
state_dir        = "/var/lib/crha/privileged"    # the used list (used)
log              = "/var/log/crha/privileged.jsonl"
clock_skew       = "60s"

[[trust]]
name          = "crhs"                      # local only; crhs is matched by public-key fingerprint
role          = "crhs"
format        = "sshsig"
key           = "ssh-ed25519 AAAA… crhs-signing"
kinds         = ["execute", "cosign"]
require_exact = true                        # authorizing alone accepts exact only
max_ttl       = "5m"                        # deadline is mandatory, and deadline - issued_at ≤ 5m
allow = [
  { method = "exec",       prefix = "systemctl restart " },
  { method = "exec",       regex  = 'apt-get (update|upgrade -y)' },
  { method = "file.write", prefix = "/etc/nginx/" },   # also allows reading these paths
  { method = "file.read" },                            # no prefix or regex = any target of the method
]
deny  = [
  { method = "file.read",  regex  = '/etc/(shadow|gshadow|sudoers.*)' },
  { method = "file.write", prefix = "/etc/crha/" },        # crhs cannot change crha's configuration or trust
]

[[trust]]
name    = "ktren-yubikey"
role    = "user"
format  = "sshsig"
key     = "sk-ssh-ed25519@openssh.com AAAA…"
kinds   = ["execute"]
max_ttl = "24h"

[[trust]]
name          = "ktren-passkey"
role          = "user"
format        = "webauthn"
rp_id         = "crh.example.com"
origins       = ["https://crh.example.com"]
credential_id = "…"
key           = "cose:…"
require_uv    = true
kinds         = ["execute", "require-cosign"]

[[trust]]
name  = "local-admins"
role  = "local"
uids  = [0, 1000]
kinds = ["execute"]
```

- `aliases` is a UUID list configured by the node's root; crhs cannot change it. It usually holds
  the UUIDs of the node groups the node belongs to (the WebUI shows a node group's UUID for
  copying), but any UUID the node is willing to accept works. A `groups` key fails startup with a
  hint to use `aliases`; it is not silently ignored.
- The configuration file must be owned by the user that runs the privileged mode and must not be
  writable by the group or other users, otherwise it is refused. Unknown fields are errors, and so
  are duplicate entry names.
- When several trust entries contain the same public key or credential id, a signature matches the
  first of them.
- `SIGHUP` reloads the configuration. A file that does not load keeps the old configuration and logs
  the error. Established connections are not closed by a reload, even when their peer uid is no
  longer in the new configuration; new connections are checked against the new configuration.

### Trust entry fields

| Field | Applies to | Meaning |
|---|---|---|
| `kinds` | All | See the tables above |
| `max_ttl` | All | `deadline - issued_at ≤ max_ttl`; without it there is no extra limit, and `deadline` is still mandatory |
| `require_exact` | All (mainly crhs) | Authorizing alone accepts `exact` only |
| `require_task` | `user` | Accepts only one-shot authorizations with `task_ids` (the `crhs` role always requires them) |
| `require_uv` | `user` | Requires the UV (user verification) flag: the WebAuthn authenticatorData, or the flags of an `sk-*` SSH key signature. A non-`sk-*` SSH key cannot satisfy it and the configuration is rejected |
| `allow` / `deny` | All | Guard rules, see below |
| `env_allow` | All | Names of environment variables that a task may carry; empty by default. `PATH` cannot be listed because the privileged mode fixes it |

A `local` entry has `uids` instead of a key and no `format`. It approves through the socket, not by
signing.

### Guard rules

Rules are a simple filter, not a rule engine. Each rule is written as `{ method = …, prefix = … }`
or `{ method = …, regex = … }`:

- `method` is required in both `allow` and `deny`, and is `exec`, `file.read` or `file.write`. A
  `file.write` rule also covers `file.read`.
- `prefix` and `regex` are mutually exclusive; neither means any target of that method. `prefix` is
  sugar for `^<quoted prefix>.*$`. `regex` uses RE2 syntax with an implicit full match
  (`^(?:…)$`); the pattern is at most 1000 bytes and must compile on its own. A pattern such as
  `a)|(b` is unbalanced and would break out of the implicit full match, so it is a configuration
  error.
- `regex` should use only the subset that Go `regexp` and C++ RE2 share: no `\C`, `\p{Script=…}`,
  lookaround, backreferences, `\Z` or `\h`; character classes, `(?i)` and `\p{Latin}` are fine. The
  privileged mode (Go) is the final authority. crhs (the Node `re2` package) only previews; when a
  pattern fails to compile there, it is conservative: `allow` does not match and `deny` matches. The
  shared decision cases cover both outcomes.
- Evaluation order: `deny` first, and any hit rejects; when `allow` is non-empty, one of its rules
  must match.
- A `file.write` rule covering `file.read` holds for `allow` only. A `deny` `file.write` rule
  matches writes only, consistent with crhs rules.
- Rules constrain the method and target only, not stdin or the written content. Allowing
  `{ method = "exec", prefix = "bash" }` allows any script. Use an `exact` authorization when the
  content must be constrained.
- Environment: a task may carry only variables listed in `env_allow`, and `PATH` is fixed by the
  privileged mode. Otherwise variables such as `LD_PRELOAD` or `PATH` could bypass command-line
  rules.

### Cosigning

When a user trust entry's `kinds` contain `require-cosign`, every use of that user's authorization
must carry a crhs cosignature:

- The cosignature is another entry in the same payload's `signatures` array, issued by a
  `role = "crhs"` entry whose `kinds` contain `cosign`.
- Both signatures cover exactly the same nodes, command, spec hash, `task_ids`, `attempt` and
  deadline. There is no second payload.
- **The crhs entry's other limits (`require_exact`, `max_ttl`, `allow`/`deny`) do not apply to a
  cosignature**; only the role and the `cosign` capability are checked. A cosignature confirms the
  same object that the user signed; it is not a second authorization, so the limits that govern an
  authorization do not govern it.
- The effect is that a task runs only when both the user's authorization and crhs's confirmation are
  present. crhs cannot execute a privileged task alone, and a user authorization cannot bypass crhs
  policy on its own.

### Trust aliases

`aliases` is a UUID list configured by the node's root. crhs cannot change it. An authorization is
addressed to the node when its payload `nodes` contains the node's `node_id` or any alias. The list
usually holds the UUIDs of the node groups the node belongs to, but it may hold any UUID the node is
willing to accept. It is not a node group: it does not give the node a name, and crhs-side group
membership does not follow from it.

- Aliases are validated as canonical lowercase UUIDs without duplicates. The `groups` key fails
  startup with a hint to use `aliases`.
- Because crhs-side node groups cannot change what the node's root trusts, the node decides which
  group-addressed authorizations it accepts. Expanding a node group into node UUIDs when signing was
  rejected for reusable authorizations: such an authorization would not cover nodes that join the
  group later.
- crhs compares the aliases in the cached trust summary with its own node groups and shows the
  out-of-sync warnings below. Each warning names the UUID to add or remove.
  - **Superfluous alias** (prominent warning, privilege risk): the node trusts a node group's UUID
    but is not a member of that group. A reusable authorization issued to that group is still valid
    on this node.
  - **Alias points at an unknown UUID** (warning): the UUID is neither an existing node group nor
    the node itself.
  - **Missing alias** (hint): the node is a member of a node group but does not trust it. This only
    affects reusable authorizations issued to that group, and it is shown for `forward` nodes only.
  - **Unknown trust entry** (warning): the trust configuration contains a signer that crhs does not
    know, neither its current signing key nor any registered user credential.
- When crhs selects a reusable authorization addressed to a node group and the cached aliases of a
  `forward` node do not contain that group, crhs does not send the task. It ends the node's task as
  `failed` with `error_code = alias_missing` and a message that names the missing group UUID and how
  to configure it ([Authorization path](#authorization-path)). One-shot authorizations are not
  affected because they already name node UUIDs, and neither are ordinary tasks, `native` nodes or
  `ignore` nodes.

## Validation flow

The privileged mode validates a `task.start` in nine steps. Steps 1 and 9 belong to the socket and
the caller; steps 2–8 are the pure decision. The message formats and the error codes are in
[task.start](protocol.md#taskstart) and [Privilege messages](protocol.md#privilege-messages).

1. **Peer uid**: `SO_PEERCRED` must show `unprivileged_uid` for a task submission, and a uid in a
   `local` trust entry's `uids` for a local approval.
2. **The task itself**: the paths of a file task satisfy [Methods and
   targets](#methods-and-targets).
3. **Signatures to trust entries**: for each signature on the payload, find the trust entry by
   public key (or credential id) and verify the signature. A signature that matches no trust entry
   is ignored, because the authorization may also carry signatures for other nodes. A signature
   that matches an entry but does not verify makes the whole authorization invalid. When no
   signature matches any trust entry, the authorization is invalid.

   A `role = "crhs"` or `user` signature is a **candidate**. Steps 4–8 are checked for each
   candidate in `signatures` order, against that candidate's trust entry, and the first candidate
   that passes all of them wins. When none passes, the failure of the first candidate is reported.
   A `role = "crhs"` signature with only `cosign` is a candidate too: it fails step 7 for lacking
   `execute`, but it can still provide the cosignature at step 8 for another candidate.
4. **The authorization body**: `nodes` contains the node's `node_id` or one of its aliases (or
   exactly `["*"]`); `issued_at ≤ now + skew`; `deadline` is present and `≥ now - skew` (without it
   the code is `authorization_expired` and the message is "authorization has no deadline");
   `max_ttl` and `require_exact` hold. `now` is the node clock, see [Clock](#clock).
5. **One-shot constraints**: the task id must not have executed before; the authorization must be
   later than the used list's watermark (`issued_at ≤ watermark` is refused with
   `authorization_rejected`, see [Used list](#used-list)); when the authorization carries
   `task_ids`, the task id must be in the list, `attempt` must equal the `attempt` of `task.start`,
   and `(authorization id, task id)` must not be in the used list; a `role = "crhs"` authorization
   and every cosignature must carry `task_ids`; a trust entry with `require_task` requires them too.
6. **The command limit**: for `exact`, the method, target and `spec_sha256` are equal; for
   `prefix`, the method matches (`file.write` includes `file.read`) and the target starts with the
   prefix.
7. **The trust entry**: `kinds` contains `execute`; the `deny` and `allow` rules; `env_allow`; and
   for `require_uv`, the signature carries the UV flag.
8. **Cosignature**: when the user trust entry has `require-cosign`, a `role = "crhs"` signature with
   `cosign` must exist on the same payload and verify.
9. **Record and execute**: record the task id and `(authorization id, task id)` in the used list
   (for a local approval, only the task id; persisted, or memory only with `--no-persist-used`),
   write the local log, execute, and write the result log. When the local log write fails, the task is refused, because no privileged execution
   may go without a log. The used record is already written, so the task id cannot be reused and
   crhs has to submit a new task.

Any failure is returned as a `task.start` error response, `[1, id, "task.start", false, [code,
message]]`. `code` is `authorization_required`, `authorization_invalid`, `authorization_expired` or
`authorization_rejected` (mapping in [task.start](protocol.md#taskstart)), and `message` names the
step that failed. A rule or path refusal is a retryable `authorization_rejected` too, because a
different signer, such as the owner, may pass.

The privileged mode completes the authorization check **before** it sends the success response
(acceptance). On a refusal nothing executed, nothing was written to the used list, and there is no
side effect, so the same task id can be retried with a higher `attempt`. `task.input` is accepted
only after acceptance.

**Execution environment**:

- The task runs under the privileged mode's own Linux identity.
- Environment: a fixed `PATH`; `HOME`, `USER` and `LOGNAME` from the root account; `SHELL` from the
  discovered sh; `LANG` and `LC_ALL` are `C.UTF-8`. Task variables are kept only when they are
  listed in `env_allow` and provided by the task; they may override these variables except `PATH`
  (see [The exec environment](execution.md#the-exec-environment)).
- A task with stdin: the privileged mode first writes the complete stdin to a 0600 temporary file
  in the `stdin/` subdirectory of the privileged state directory (0700, owned by the privileged
  mode) and verifies the size and `sha256`; only then does it start the process. Otherwise a
  process could read the stdin that an `exact` authorization approved before the authorization
  check finished. Before writing, it checks the free space of the file system against the declared
  size and keeps at least the larger of 5% or 64 MiB; when that does not fit, the task is refused
  with `input_too_large`. The temporary file is deleted when the task ends. A native helper has no
  `privileged.toml`; its default root is `/var/lib/crha/privileged`, and the environment variable
  `CRHA_PRIVILEGED_STDIN_DIR` overrides it (sudo needs `env_keep` for that).
- For a non-`exact` authorization, cwd is `/`.
- The process is put into a new process group.
- The privileged mode performs its own timeout handling.

### Clock

The signer's clock writes `issued_at` and `deadline`, and the node's clock checks them. This is the
only part of the trust configuration that depends on both clocks agreeing; the handshake does not
depend on it ([Handshake and replay
protection](protocol.md#handshake-and-replay-protection)). The concessions are:

- The node must run a time synchronization service such as NTP. The tolerance is `clock_skew`
  (default 60 seconds).
- When the node clock is slow, an expired authorization stays usable a little longer; when it is
  fast, a new authorization may be judged as issued in the future or may expire quickly. The first
  is an in-host problem, because whoever can change the node clock can already do more, and it is
  outside the threat model. The second only causes refusals, not extra privilege.
- crha computes the offset from crhs during every handshake and reports it in
  `facts.clock_offset_ms`. When the offset exceeds a threshold (default 60 seconds, configured
  separately as `clock_warn` in `crha.toml` and `crhs.toml`), crha writes a warning log (also to
  journald), and crhs writes a warning log and shows a warning in the WebUI. Nothing else happens.
  The offset is measured once per connection and is not re-measured while the connection lasts. The
  crhs API returns the offset and crhs's `clock_warn` (a positive offset means the node clock is
  ahead; `clock_warn = 0` disables the warning), and the WebUI localizes the text. The `clock_skew`
  used by the authorization check is a different setting (called "authorization clock tolerance" in
  the WebUI) and is unrelated to the measured offset.
- **Clock rollback**: communication is unaffected. For authorization, an authorization that had
  expired becomes "not expired" again until the clock is corrected. Reuse of a one-shot
  authorization is prevented by the used list, not by the clock; records are kept until
  `deadline + max(1h, clock_skew)`, so a rollback within that margin cannot make an authorization
  usable again through cleanup. With a longer rollback, the record may already have been cleaned up
  and a one-shot authorization may be usable again, because the watermark is memory only.
- The alternative of having the privileged mode remember the largest time it has seen and use it
  instead of the system clock was rejected: it would block rollback, but a clock that jumps into
  the future and is then corrected would make every authorization look expired and lock privileged
  execution, which is the same problem as the timestamp scheme in the handshake.

## Local approval

A user logs in to the node over SSH and runs `crha pending` to list the tasks waiting for approval,
then `crha approve <task-id>` (or `crha deny`). The CLI connects directly to the privileged mode's
socket, with the `local` role of `crh-priv`; the uid from `SO_PEERCRED` must be in a `local` trust
entry. `crha pending`, `approve` and `deny` connect to `/run/crha/privileged.sock` by default, which
`--socket` or the environment variable `CRHA_PRIVILEGED_SOCKET` overrides (precedence: `--socket`,
then the environment variable, then the default). This is the only built-in path in crha, and it is
used only for manual approval on the node. It does not go through crhs and needs no key.

The flow (wire format in [Privilege messages](protocol.md#privilege-messages)):

1. When crhs selects the local approval path, it sends `local.request` to the node with the task id,
   attempt, spec, and an `input_preview` of the first 4 KiB of the stdin or file content. The task
   enters the pending list. **`task.start` is not sent yet**, and the complete input is not
   transferred.
2. `crha pending` shows the complete spec (method, target, argv, env, cwd, the size and hash of the
   stdin or content plus its first 4 KiB preview, the `file.read` start line and line count, mode,
   owner, overwrite, edits) and the `spec_sha256`. Text previews escape control characters; binary
   previews show only size and hash; an interpreter command with stdin carries a warning that it
   runs as a script. `crha approve` and `crha deny` show the spec again and ask for confirmation
   (`--yes` skips it), and the request carries that `spec_sha256`. The privileged mode compares it
   with the pending record and refuses a mismatch, so crhs cannot replace the spec after the
   administrator has seen it. The privileged mode records the approver's uid (a denial records the
   denial) and reports the result to crhs with `local.decision`.
3. After crhs receives `approved`, it sends `task.start` with the same attempt and an empty
   `authorizations`. The privileged mode then runs the [validation flow](#validation-flow): steps 3
   and 4 do not apply because there is no authorization object; step 5 only checks that the task id
   has not executed; step 6 compares the spec hash with the approved one; step 7 uses the rules of
   the approver's `local` trust entry. On success it consumes the approval and records the task id
   in the used list.

Pending and approved records exist only in the privileged mode's memory. They do not time out on
their own; they end when crhs withdraws (`local.withdraw`), when the request is denied, or when the
privileged mode restarts. After a restart, crhs sends `local.request` again. A disconnect while
waiting does not make the task `unknown`, because execution only starts with `task.start`. At most
1024 pending or approved records are kept; a new request beyond the limit is refused with
`privileged_unavailable` until an approver decides or withdraws one. A repeated `local.request` for
the same `(task id, attempt)` is idempotent; a different spec for the same pair is refused with
`invalid_spec`.

**Local approval is for a single task only.** Tasks of a task group do not use it: crhs does not
send `local.request` for them. When no other path exists, the node's task fails directly with
`authorization_required` and a message that suggests running on a single node. Approving node by
node contradicts the purpose of batch execution, and it would make crhs track the local approval
state of every node of the group.

## Waiting for signatures

An approval wait has no automatic deadline; only a signature wait expires.

- **24-hour expiry**: when a task has been in `awaiting_authorization` for 24 hours
  (`AUTHORIZATION_WAIT_MS`, the same as the default TTL of a user-path authorization) without a
  signature, it ends as `rejected` with error code `authorization_wait_expired`.
  - The start is the approval decision when there was one, otherwise the task's creation.
  - The check runs at crhs startup, before it accepts requests, and then every 5 minutes.
- **Ending with the session**: for tasks and task groups created by a session, stopping the session
  or ending its run ends the unfinished approval and signature waits together:
  - approval waits are treated as rejected, signature waits as cancelled;
  - the reasons are "the session was stopped" and "the session's run ended";
  - see [Session state](agent-runtime.md#session-state).

Both have the same entry points in the WebUI:

- The approvals page lists, besides the pending approvals, the tasks and task groups that wait for
  the current user's signature (`awaiting_authorization` with the current user as owner; a task of a
  task group appears once, as the group). Opening one leads to the signature area of the task page
  or the task group page (`/task-groups/<id>`). The to-do count in the top navigation is the sum of
  both.
- A session's tool card shows "waiting for your signature" and a link to the signature area while
  the task or task group is `awaiting_authorization`, next to the waiting-for-approval notice. The
  agent's tool reports that link in its waiting state.
- The top navigation has a tasks page that lists the user's own tasks across nodes (all tasks for an
  administrator). Task visibility does not depend on node access (`GET /api/tasks`, filterable by
  state, node and initiator, cursor pagination). Items waiting for the current user are on the
  approvals page.

## Revoking trust

Authorizations have no revocation mechanism. To withdraw a signer's permission immediately (for
example, when crhs's signing key is suspected to be compromised), change the node's trust
configuration:

1. Remove the trust entry from `privileged.toml`, or rotate the key it trusts (for example, replace
   crhs's authorization signing key).
2. Make the privileged mode re-read the configuration: send SIGHUP to the privileged process,
   usually through the service manager (systemd: `ExecReload=/bin/kill -HUP $MAINPID`). Each process
   re-reads only its own file: `crha privileged run` re-reads `privileged.toml`, and `crha run`
   re-reads `crha.toml`. An invalid file keeps the running configuration and logs the error.

Changing the trust configuration itself needs an authorization from an existing trust entry (a
`file.write` on `privileged.toml`) or a local edit on the node. Tasks that were already accepted
continue; later `task.start` requests are checked against the new configuration.

Revocation was rejected as a mechanism because:

- revocation entries would be pushed by crhs, which is not trustworthy when it is compromised, so
  revocation cannot help in exactly the case that matters;
- a node's crha only sees the authorizations addressed to it and has no global view; one-shot
  authorizations cannot be replayed (used list), and reusable authorizations are bounded by their
  command limit, guard rules and `deadline`;
- a revocation cannot reach an offline node, and it has no effect on `native` or SSH nodes.

## Server-side authorization

crhs caches the trust reports that nodes push and plans a path from the cache with RE2 (the Node
`re2` package) for the task's owner only: the owner's user trust entries and credentials, never a
shared user's or another administrator's. It signs crhs authorizations with SSHSIG. Planning is a
preview, not a permission: the privileged mode re-verifies everything against its current
configuration before executing. A failed match in crhs only means more waiting or a refusal, never
extra privilege.

### Trust cache

crhs stores the `TrustSummary` that a node's privileged mode reports, its digest, and when it was
last updated (`trust_report`, `trust_digest`, `trust_updated_at`). The run identities of both modes
are part of the summary.

- crha pushes `trust.summary` once after the handshake, and again when the digest changes or when
  the privileged mode connects or disconnects. crhs never queries it ([Trust
  summary](protocol.md#trust-summary)).
- Before the unprivileged mode forwards an `authorization_*` refusal, it queries the privileged mode
  again. When the digest changed, it pushes the new summary first, so crhs's cache is current when
  it handles the refusal.
- crhs updates the cache and writes an audit event (`node.trust_changed`) when the status or digest
  actually changed, recording both digests and the new status.
- The WebUI shows which signers a node trusts and can export a `privileged.toml` fragment. A task's
  authorization record stores the digest that was used; when the digest changes while the task
  waits, the task is planned again.
- When the trust report is not `ok`, or the node has not reported again since it reconnected (the
  cache is stale), a `forward` node's privileged task fails with `privileged_unavailable`.

crhs also compares the cached `TrustSummary.aliases` with its node groups and shows the out-of-sync
warnings of [Trust aliases](#trust-aliases).

**Stored authorizations**: crhs stores an authorization a user submits after checking that it has a
deadline, is not expired and is not issued in the future; a submission that fails these checks is a
400. The stored row holds the payload, signatures, issuer, task ids and deadline, and is used for
display and for reuse. The authorization list is in the WebUI's administrative area, visible to
administrators only, with cursor pagination. `[retention].tasks` deletes stored authorizations whose
`deadline` is older than the retention window (90 days by default); a row without a deadline is
kept.

### Authorization path

When crhs receives a privileged task, it chooses a path in this order:

1. **crhs authorization rules**: the rule chain decides ([Authorization
   rules](access-control.md#authorization-rules); a user acting in the WebUI skips it), followed by
   an optional auto review. A deny ends the task; when an approval is needed, the chain is walked
   upward first.
2. **The unprivileged mode's behaviour**: `native` and `ignore` need only step 1; `reject` refuses
   directly; an SSH node is treated as `ignore` and gets an output notice; `forward` continues with
   step 3.
3. **Planning with the cached `TrustSummary`**, for the task's owner only:
   - When a crhs trust entry can authorize alone, crhs signs an `exact` + `task_ids` + short
     `deadline` authorization (5 minutes by default), adds it to the same payload's `signatures`,
     and sends it. crhs considers only crhs trust entries whose public key equals its current signing
     key; a node may trust several crhs keys during a rotation.
   - When the owner's user trust entries can authorize:
     - crhs first looks for an authorization that this owner already signed, that is still valid,
       has a `deadline`, and covers this task (matching nodes, command limit and deadline). An
       authorization without a `deadline` is not reused, because the node refuses it.
     - Otherwise it creates a signature wait that is shown to the owner only (a Passkey in the
       WebUI or `crha grant`), or it waits for local approval on the node. An authorization that
       the owner signs for a specific task is valid for 24 hours by default, bounded by the trust
       entry's `max_ttl`.
     - When a cosignature is required, crhs adds its own signature to the same payload.
   - When a `local` trust entry can authorize (**single tasks only**), crhs sends `local.request`
     and shows "you can also run `crha approve` on the node" in the signature wait. When the owner
     signs in the WebUI first, crhs withdraws the local request (`local.withdraw`). A task group
     skips this path.
   - When no trust entry can authorize, crhs refuses directly and tells the caller that no one on
     this node can authorize this command.
- **Reusable authorizations issued to a node group**: crhs uses the cached `TrustSummary.aliases` to
  decide whether a node accepts such an authorization. When the alias is missing, crhs does not send
  the task to that node and ends it as `failed` with `error_code = alias_missing`, naming the
  missing node group UUID and how to configure it. This applies only when all of the following hold:
  the node is `forward`, the task is privileged, crhs selected a reusable authorization issued to a
  node-group UUID, and the node's cached aliases do not contain that group. Ordinary tasks, `native`
  and `ignore` nodes, and one-shot authorizations (which are already expanded to node UUIDs) are not
  affected. The decision uses the cached `TrustSummary`; re-running after the node reports again is
  enough.
- **A task group's user path shares one payload**: when the trust digest of any node in the group
  changes and the payload is recomputed, every task of the group that still waits switches to the
  new payload with the highest attempt, and signatures for the old payload become invalid.
- **A Passkey assertion is valid for one RP only**: when the nodes of a task group trust Passkeys
  under different RPs, the waiting page offers one signing button per credential. Each signature
  releases only the nodes whose trust entries accept it, and the other nodes keep waiting instead of
  failing the whole group.
- A signature wait is distinct from a rule approval: when the policy has passed but the signature is
  missing, the task is `awaiting_authorization`, not `awaiting_approval` ([Waiting for
  signatures](#waiting-for-signatures)).

**Preview and fallback**: crhs's rule calculation is only a preview, not a final authorization. When
crha refuses an authorization before the `task.start` success response (acceptance):

1. crhs uses the `TrustSummary` cache that was updated with the refusal (see [Trust
   cache](#trust-cache)).
2. It recomputes the plan with `attempt + 1`, does not retry the same crhs signature path, and
   prefers the owner's user or local path (local only for a single task):
   - fallback to the user path: the task enters `awaiting_authorization` and waits for the owner to
     sign an authorization for `attempt + 1`;
   - fallback to the local path: crhs sends `local.request` with `attempt + 1`, and the rest is the
     same as choosing local approval directly. The refused task was never accepted and the node has
     no record of it, so nothing needs cleaning up;
   - when both are available, both are offered, the first decision wins, and the other is withdrawn.
3. When no user or local path is available (a task group where only local remains counts as none),
   the task ends as `rejected` with the code of crha's refusal and a message that lists the paths
   that were tried.
4. Tasks that were already accepted and other nodes' tasks that already executed are not rolled
   back.

When crhs wrongly decides that there is no path, it creates no task, so a later crha refusal cannot
repair it. The Go and TypeScript implementations therefore share one set of authorization decision
cases covering rule matching, prefix/RE2, env, aliases, trust digest and time boundaries.

### Authorization signing key

- `ssh-ed25519`, generated on first start and stored encrypted with the master key in the `secrets`
  table (`authorization_signing_key`); signing uses `node:crypto`. crhs signs with the newest such
  row.
- Rotation: add the new public key to every node's trust entry, switch crhs to the new key, then
  remove the old public key. Every trust configuration edit is itself a privileged task that needs a
  user authorization, or a local edit on the node.

## Extension points

The following are not implemented, but the current design must not block them. The reserved
mechanisms are signed trust bundles and additional trust sources for the trust configuration.

### Signed trust bundles

- Idea: an administrator key kept offline signs a trust bundle (a set of trust entries, a monotonic
  version and a validity period). The bundle is distributed to the privileged mode through crhs and
  the unprivileged mode, and is used to manage users across many nodes. crhs only distributes it and
  cannot forge it.
- Reserved:
  - trust entries are loaded by source (the current version has only `privileged.toml`), and a
    trust bundle can be added as a second source later;
  - the `role` field is open, so a role that can only sign trust bundles can be added later;
  - each entry in `TrustSummary` carries a source field (always `local` in the current version).

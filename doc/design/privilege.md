# Privilege and authorization

A privileged task is a task that a node runs only after it has verified an authorization. The
authorization comes from crhs, from the task's owner, or from a local approval on the node, and the
node makes the final decision. This document covers the modes, authorizations, trust configuration,
the node's validation, and how crhs chooses a path. Message formats are in
[Privilege messages](protocol.md#privilege-messages).

"Privileged" means "needs an authorization", not "runs as root". crha has an unprivileged mode, which
talks to crhs over the network and runs ordinary tasks under its own identity, and an optional
privileged mode, which has no network access and runs authorized tasks under its own identity. The
two are the same binary run as two processes; to crhs they are one node. Their identities are a
deployment choice: running the privileged mode as `deploy`, for example, makes "run as deploy" an
operation that needs an authorization.

## Threat model and scope

| Concern | How it is handled |
|---|---|
| Compromised crhs | A node that trusts only users cannot be made to run a privileged task by crhs alone. |
| Network attacker | The Noise channel between crhs and crha ([Transport security](protocol.md#transport-security)). |
| Prompt injection, agent overreach, a stolen API token | crhs rules, and the node's trust configuration. |

Threats inside the host are out of scope: other local users attacking the privileged mode, or a
compromised unprivileged mode forging requests. The socket between the modes is therefore not
encrypted, the privileged mode has no identity key, and its trust report is not signed. A forged
request still cannot run anything without a valid authorization, and an attacker who controls the
host already controls more than the socket.

## Privilege modes

Each node sets its mode in `crha.toml` and reports it to crhs.

| Mode | Behavior | Who can make a privileged task run |
|---|---|---|
| `forward` | Forwards the task to the privileged mode | Whoever the node's trust configuration trusts |
| `native` | Runs the task through a short-lived helper started with `sudo -n`, `doas -n` or `run0` | crhs, limited only by crhs rules |
| `ignore` | Runs the task like any other task | crhs, limited only by crhs rules |
| `reject` | Refuses every privileged task (the default) | Nobody |

Only `forward` is a security boundary. `native` exists to obtain another identity non-interactively;
permission to start the helper without a password already means crhs has that identity. `ignore` is
common when the unprivileged mode itself runs as root.

An SSH node is treated like `ignore`, with a notice in the task output.

### Native mode

`native` does not run the task's command through sudo directly. It starts the crha binary as a helper
(`crha privileged stdio`) under the target identity, and the helper runs the task. A helper is needed
because:

- An unprivileged process may not signal a root process, and killing sudo or doas leaves the root
  child running. Cancellation and timeouts must be handled by a process with the same identity, so
  crha cancels through the `crh-priv` protocol and never signals the helper.
- File tasks need the target identity too, which running a single command cannot provide.

The cost is that sudoers sees only `crha privileged stdio` and cannot restrict the command; the helper
logs every task's full spec instead. Use `forward` when per-command limits are needed. When the
escalation tool fails, the task fails with an explanation; it never falls back to unprivileged
execution. `run0` support is experimental.

## The privileged mode

The privileged mode listens on a local Unix socket and tells peers apart by their uid
(`SO_PEERCRED`): the unprivileged mode's uid submits tasks, and uids in a `local` trust entry approve
tasks locally. It keeps a used list and a local log of every privileged task.

Editing the trust configuration is itself a privileged task: a `file.write` to `privileged.toml`
followed by a reload. It needs an authorization from an existing trust entry or a local edit, so crhs
cannot change what a node trusts. The recommended crhs trust entry denies writes under `/etc/crha/`.

Each process reloads only its own configuration file on SIGHUP. A file that fails to load leaves the
running configuration in place.

## Methods and targets

Every task has one method and one normalized target, which authorizations and guard rules match.

| Method | Tasks | Target |
|---|---|---|
| `exec` | `exec` | The argv rendered canonically with POSIX shell quoting |
| `file.read` | `file.read`, `file.stat`, `file.list` | The absolute path |
| `file.write` | `file.write`, `file.edit`, and everything `file.read` allows | The absolute path |

- Canonical rendering means a later argument cannot pose as part of an earlier one. A shell-mode task
  renders as `/bin/sh -c <script>`, so a rule like `prefix = "systemctl restart "` never matches a
  shell script, and `;` or `$()` cannot bypass it. Allowing scripts needs an explicit `/bin/sh -c`
  rule.
- Privileged file paths must be absolute and normalized, and no component may be a symbolic link.
  Otherwise `/etc/nginx/x` could link to `/etc/shadow` and bypass every path rule. Paths are opened with
  `openat2(RESOLVE_NO_SYMLINKS)` and every later operation uses the opened file descriptor, so the
  path is not resolved twice. Where `openat2` is unavailable, privileged file tasks are refused; there
  is no weaker fallback. Hard links and bind mounts are not prevented, so a directory a rule allows
  should be writable only by the target identity.
- Reads and edits accept regular files only, so opening a device or FIFO has no side effect.
- A `prefix` authorization and guard rules do not constrain file mode or owner; use `exact` for that.

## Authorizations

An authorization is a signed payload that names the nodes it addresses, an optional command limit,
an issue time, a deadline, and optionally the tasks it is for. All signatures, including a crhs
cosignature, cover the same payload, so signers can never disagree about what they approved. The
encoding is in [Authorization object](protocol.md#authorization-object).

- **Deadline.** Every authorization must have one. A node refuses one without a deadline, crhs refuses
  to store it, and `crha grant` refuses to sign it, because there is no revocation: an authorization
  without an expiry could be used forever ([Revoking trust](#revoking-trust)). A trust entry can also
  cap the lifetime with `max_ttl`.
- **Nodes.** Node UUIDs, node group UUIDs, or `*` (every node that trusts the signer). Names are
  resolved before signing, so renaming does not affect issued authorizations. A node accepts an
  authorization that names its own id or one of its [trust aliases](#trust-aliases).
- **Command limit.** `exact` binds the method, the target and the hash of the complete task spec,
  including environment, working directory, input and file content. Approving "write
  `/etc/nginx/nginx.conf`" therefore approves that content. `prefix` binds only the method and a target
  prefix, not input or content. No limit means any command.
- **One-shot or reusable.** A one-shot authorization lists task ids and an attempt number and is valid
  only for those tasks; a reusable one is valid for any matching task until its deadline. Scheduled
  tasks and authorizations pre-signed with `crha grant` rely on reuse. crhs authorizations, all
  cosignatures, and every approval of a specific task are one-shot.
- **Task groups.** One one-shot authorization covers the whole group, listing node and task id pairs
  position by position, so the user signs once. A node accepts only the task id paired with itself, so
  crhs cannot replay one node's task on another. Groups are expanded to node UUIDs when signing, so
  later membership changes do not widen it. Nodes that refuse before acceptance get a new payload with
  a higher attempt, and nodes that already ran are unaffected.

### Used list

The privileged mode appends every task it runs to a used list, and writes the record to disk before
the task starts. A one-shot authorization is consumed once per task, and a task id runs only once, so
replaying an authorization or a `task.start` has no effect even after a crash.

Records are kept until shortly after their authorization's deadline, so the list stays small. When
the list is full, the oldest records are evicted and an in-memory watermark refuses any authorization
issued at or before an evicted one that could still be valid. The watermark is not persisted: after a
restart, an authorization whose record was both evicted and compacted away could run again before its
deadline. This is an accepted trade-off. `--no-persist-used` keeps the list in memory only, for
devices with limited flash endurance, with the same trade-off after every restart.

### Signing methods

| Signer | Form | Where it is signed |
|---|---|---|
| crhs | SSHSIG with an Ed25519 key | Inside crhs |
| User SSH key, including FIDO keys | SSHSIG | On the user's workstation with `crha grant`, which calls `ssh-keygen -Y sign` |
| User Passkey | WebAuthn assertion over the payload | In the WebUI |

SSHSIG was chosen because users already have SSH keys and agents, `ssh-keygen` handles encrypted keys,
agents and FIDO touch, and any authorization can be checked by hand with `ssh-keygen -Y verify`.
`crha grant` never reads the private key.

Signature counters are ignored (synchronized Passkeys always report 0); the used list prevents replay.
A trust entry can require user verification (`require_uv`).

Trusting a Passkey has a specific limit: the page that shows the authorization is served by crhs, so a
compromised crhs can show one thing and ask the user to sign another. A Passkey entry is therefore not
treated as stronger than an SSH key entry.

## Trust configuration

A node's privileged mode trusts the signers listed in `privileged.toml`
([Privileged configuration](../guide/reference/privileged-config.md)). Each entry has a role:

| Role | Signer | Capabilities |
|---|---|---|
| `crhs` | crhs's signing keys | `execute`, `cosign` |
| `user` | A user's SSH key, FIDO key or Passkey | `execute`, `require-cosign` |
| `local` | Local uids, approving with `crha approve` | `execute` |

`execute` lets a signer authorize a task alone. `cosign` lets crhs confirm a user authorization that
requires it, and `require-cosign` makes a user's authorizations need that confirmation. crhs's two
capabilities are independent: an entry with only `cosign` means crhs can never authorize alone, and no
crhs entry means crhs takes no part in privileged tasks. Only crhs can cosign, so users cannot cosign
for each other.

An entry can also limit what it authorizes: guard rules, an environment allowlist, a maximum lifetime,
`exact`-only (`require_exact`), one-shot only (`require_task`) and user verification (`require_uv`).

The configuration must belong to the privileged mode's user and not be writable by others. Unknown
keys and duplicate names are errors.

### Guard rules

Guard rules are a filter, not a rule engine. Each rule names a method and optionally a target `prefix`
or an RE2 `regex` that must match the whole target. `deny` rules are checked first and any match
refuses; if `allow` rules exist, one must match.

- A `file.write` allow rule also allows reading the same paths; a `file.write` deny rule blocks only
  writes, as in crhs rules.
- Rules constrain the target only, not input or content: allowing `exec bash` allows any script. Use
  `exact` authorizations when content matters.
- A task may carry only the environment variables an entry allows, and `PATH` is fixed, so variables
  like `LD_PRELOAD` cannot bypass command rules.
- The node is the authority on regular expressions. crhs evaluates the same rules only to plan, and a
  pattern it cannot compile is treated conservatively (allow does not match, deny does).

### Cosigning

With `require-cosign`, a user's authorization runs only when crhs has also signed the same payload.
crhs cannot run the task alone, and the user cannot bypass crhs rules. A cosignature confirms the
object the user signed rather than authorizing on its own, so the crhs entry's other limits (guard
rules, `require_exact`, `max_ttl`) do not apply to it.

### Trust aliases

`aliases` is a list of UUIDs that the node accepts as its own address, usually the UUIDs of the node
groups it belongs to. Only the node's root can change it. This lets a reusable authorization address a
node group while the node, not crhs, decides which groups it belongs to. Expanding groups to node UUIDs
when signing was rejected for reusable authorizations, because such an authorization would not cover
nodes added later.

crhs compares a node's aliases with its own group memberships and warns when they differ. An alias
for a group the node is not in is the serious case: a reusable authorization for that group still
works on the node. When crhs would use a group authorization on a `forward` node that lacks the alias,
it fails the task with `alias_missing` and explains which alias to add.

## Validation flow

The privileged mode checks a `task.start` in nine steps. Steps 1 and 9 concern the socket and
execution; steps 2–8 are the decision, and the Go and TypeScript implementations share test cases for
them.

1. **Peer.** The caller's uid is the unprivileged mode's, or a local approver's for a local approval.
2. **Task.** File paths satisfy [Methods and targets](#methods-and-targets).
3. **Signatures.** Each signature is matched to a trust entry by key and verified. Signatures for
   other nodes' entries are ignored; one that matches an entry but fails verification invalidates the
   whole authorization. Each matching `crhs` or `user` signature is a candidate for steps 4–8; the
   first candidate that passes wins.
4. **Body.** The authorization addresses this node, is not issued in the future, has a deadline that
   has not passed, and respects `max_ttl` and `require_exact`, all within the clock tolerance.
5. **One-shot.** The task has not run before and the authorization is newer than the watermark. A
   one-shot authorization lists this task with the same attempt and has not been used for it. crhs
   authorizations, cosignatures and `require_task` entries must be one-shot.
6. **Command limit.** `exact` matches method, target and spec hash; `prefix` matches method and
   target prefix.
7. **Entry.** The entry can `execute`, its guard rules and environment allowlist pass, and user
   verification is present if required.
8. **Cosignature.** If the user entry requires it, a valid crhs cosignature is present.
9. **Record and run.** The task is written to the used list and the local log, then runs. If the log
   cannot be written, the task is refused, because no privileged task may run unlogged.

All checks finish before the node acknowledges the task. A refusal therefore has no side effect, and
crhs may retry the same task with a new attempt. Rule and path refusals are retryable too, because a
different signer, such as the owner, may pass.

A privileged task runs under the privileged mode's identity with a fixed, minimal environment.
Its input is written to a private file and verified against the approved hash before the process
starts, so the process cannot read input that has not been checked.

### Clock

The signer's clock sets the issue time and deadline, and the node's clock checks them, within the
node's `clock_skew` tolerance. This is the only place where CRH depends on clocks agreeing; the
connection handshake does not ([Handshake and replay protection](protocol.md#handshake-and-replay-protection)).

- A slow node clock keeps an expired authorization usable slightly longer; whoever can change the
  node clock already controls the host, so this is out of scope. A fast clock only causes refusals.
- If the clock is rolled back, one-shot authorizations stay protected by the used list for as long as
  their records are kept. A longer rollback can make an evicted one-shot authorization usable again
  before its deadline.
- crha measures its offset from crhs once per connection. A large offset produces a warning on the
  node, in crhs and in the WebUI, and nothing else. The measured offset and `clock_skew` are unrelated
  settings.
- Having the node remember the latest time it has seen was rejected: a clock that jumps forward and
  is corrected would make every authorization look expired and lock privileged execution.

## Local approval

An administrator logged in to the node runs `crha pending` to list waiting tasks and `crha approve` or
`crha deny` to decide. The commands talk directly to the privileged mode's socket; crhs is not
involved and no key is needed.

1. crhs sends `local.request` with the task's spec and a preview of its input. It does not send the
   task itself yet.
2. `crha pending` shows the full spec and its hash. Approving sends that hash, and the node refuses it
   if the pending spec differs, so crhs cannot swap the spec after the approver has seen it.
3. After the approval, crhs sends `task.start` without an authorization, and the node checks it
   against the approved spec and the approver's `local` entry.

Pending approvals live only in the privileged mode's memory; after a restart, crhs asks again. Local
approval is for single tasks only: approving node by node defeats the purpose of a task group.

## Waiting for signatures

A task that passed its rules but needs a signature is `awaiting_authorization`, distinct from
`awaiting_approval`. Approval waits never expire, but a signature wait ends the task as `rejected`
with `authorization_wait_expired` after 24 hours, the same as the default lifetime of an owner's
authorization. The owner can also reject the wait with a reason: the task ends `rejected` with
`authorization_rejected`. Stopping a session also ends the waits of the tasks it created
([Session state](agent-runtime.md#session-state)).

The owner signs from the approvals page, the task page or the session's tool card. A task group's
signature wait counts once.

## Revoking trust

There is no revocation of individual authorizations. To withdraw a signer, remove or replace its trust
entry in `privileged.toml` and reload the privileged mode. Running tasks continue; later tasks are
checked against the new configuration.

A revocation list was rejected because crhs would distribute it, and crhs is exactly the party that
cannot be trusted when revocation matters. A node also sees only the authorizations addressed to it,
and revocation cannot reach an offline node. Instead, one-shot authorizations cannot be replayed, and
reusable ones are bounded by their command limit, guard rules and deadline.

## Server-side authorization

crhs plans an authorization path from the trust reports nodes send, but planning is only a preview:
the node re-checks everything against its current configuration. A planning mistake in crhs can only
cause waiting or a refusal, never extra privilege. crhs considers only the task owner's credentials,
never those of users the session is shared with.

### Trust cache

The privileged mode reports its trust configuration to crhs after connecting and whenever it changes.
crhs never asks for it. Before forwarding an authorization refusal, the unprivileged mode refreshes the
report, so crhs plans its retry from the node's current state. A change is recorded in the audit log.

If the report is missing, unavailable or older than the current connection, a `forward` node's
privileged task fails with `privileged_unavailable`. A task records the trust digest it was planned
with and is planned again if the digest changes while it waits.

Authorizations submitted by users are stored for reuse after crhs checks their deadline, and are
removed by retention after they expire.

### Authorization path

For a privileged task, crhs:

1. Applies its rules ([Authorization rules](access-control.md#authorization-rules)). A user acting
   directly in the WebUI skips them.
2. Applies the node's mode: `native` and `ignore` need nothing more, `reject` refuses, and `forward`
   continues.
3. Plans from the node's trust report, for the owner only:
   - If a crhs entry can authorize alone, crhs signs a one-shot `exact` authorization with a short
     deadline (five minutes by default) and sends the task.
   - If the owner's user entries can authorize, crhs reuses a valid authorization the owner already
     signed, or waits for the owner to sign one (valid for 24 hours by default), and adds a
     cosignature if required.
   - If a `local` entry can authorize and the task is not part of a group, crhs also offers local
     approval. Whichever decision comes first wins, and the other is withdrawn.
   - If nobody can authorize, crhs refuses at once and says so.

When a node refuses an authorization, crhs plans again with the refreshed trust report and the next
attempt. It never retries its own signature, so this cannot loop; it falls back to the owner's
signature or a local approval, and ends the task as `rejected` when neither is available. Tasks that
already ran are not rolled back.

When the nodes of a task group trust Passkeys for different sites, the owner signs once per site, and
each signature releases only the nodes that accept it.

### Authorization signing key

crhs keeps a list of Ed25519 signing keys, each identified by its SSH fingerprint, stored encrypted
with the master key. It creates one on first start; administrators can add and delete them while crhs
runs. A node trusts the keys it lists as `crhs` entries, with `execute`, `cosign` or both. For each
node crhs uses the newest key that node's cached trust report trusts with the needed capability, so
during a rotation a node that has not reloaded yet keeps working with the key it knows. A task group's
shared payload carries one cosignature per key its nodes need; each node ignores signatures that match
no trust entry.

To rotate, add a key, add its public key to the nodes' trust configuration and reload them at their own
pace, then delete the old key once no node trusts it. A node switches as soon as it trusts the new key,
because crhs prefers the newest usable one. Deleting a compromised key stops crhs using it at once, but
the nodes still trust it until they remove the entry, so remove it there too. Deleting the last key
leaves crhs unable to sign anything, and planning treats crhs entries as unusable.

## Extension points

Signed trust bundles are not implemented, but the design leaves room for them: an administrator key
kept offline would sign a versioned set of trust entries that crhs distributes but cannot forge. Trust
entries are already loaded by source, the `role` field is open for a bundle-signing role, and every
entry in a trust report carries its source.

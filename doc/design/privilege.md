# Privilege and authorization

A privileged task is a task that a node runs only after it has verified an authorization. The
authorization comes from crhs, from the task's owner, or from a time-limited local approval window
on the node, and the node makes the final decision. This document covers the modes, authorizations, trust configuration,
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
| Compromised crhs | A node that trusts only users cannot be made to run a privileged task by crhs alone. While a local approval window is open, crhs can run any privileged task on that node until the window closes. |
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

The helper is cancelled through `crh-priv` in every case, too when a privileged `file.push`/`file.pull`
never gets its data connection: the task ends with the transfer error, and the agent starts the helper's
watcher and forwarder before reporting it, so the cancel reaches the helper and the process is reaped
rather than running on with no one to talk to.

## The privileged mode

The privileged mode listens on a local Unix socket and tells peers apart by their uid
(`SO_PEERCRED`): the unprivileged mode's uid submits tasks, and uids in a `local` trust entry open and
close the local approval window. It keeps a used list and a local log of every privileged task.

Editing the trust configuration is itself a privileged task: a `file.write` to `privileged.toml`
followed by a reload. It needs an authorization from an existing trust entry or a local edit, so crhs
cannot change what a node trusts. The recommended crhs trust entry denies writes under `/etc/crha/`.
While a local approval window is open, that restriction is deliberately lifted: crhs can change the
trust configuration as well.

Each process reloads only its own configuration file on SIGHUP. A file that fails to load leaves the
running configuration in place.

## Methods and targets

Every task has one method and one normalized target, which authorizations and guard rules match.

| Method | Tasks | Target |
|---|---|---|
| `exec` | `exec` | The argv rendered canonically with POSIX shell quoting |
| `file.read` | `file.read`, `file.stat`, `file.list` | The absolute path |
| `file.write` | `file.write`, `file.edit`, and everything `file.read` allows | The absolute path |
| `upgrade` | `node.upgrade` | `<version> sha256:<hex>`, the target version and the binary's hash |

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
- A file task's `mode` is the nine permission bits only. Setuid, setgid and sticky are refused, and
  overwriting or editing such a file clears them; changing them needs an `exec chmod` under a `spec`
  authorization. A `prefix` grant lets crhs choose the content, the mode bits and the owner of a new
  file under the prefix, so keep prefixes narrow and end a file prefix with `/`.
- Replacing crha's binary is root on the node, so `upgrade` is a method of its own rather than a
  `file.write`, and a trust entry decides who may upgrade the node like any other method
  ([crha self-upgrade](distribution.md#crha-self-upgrade)). What that means for a crhs entry depends on
  its guard rules:
  - With only `deny` rules, everything they do not name is allowed, `upgrade` included, and an upgrade
    can replace the binary that enforces those rules. Such an entry must deny `upgrade` too, so that an
    upgrade needs a user's signature. crhs warns of one that does not (`upgrade_not_denied`), as a
    deny-only entry written before the method existed allows it silently.
  - With `allow` rules, `upgrade` is refused unless an allow rule names it. Denying it as well keeps it
    refused if the allow list is later emptied.
  - Without guard rules, crhs may already run anything as root; denying `upgrade` alone takes no power
    away from crhs and only removes the verified, logged and self-reverting way to upgrade the node.
    The entries the WebUI generates are of this kind, or only cosign.
  - An entry with only `cosign` never authorizes alone, and guard rules do not apply to a cosignature
    ([Cosigning](#cosigning)): an upgrade already needs a user's signature.
  - A `prefix` matches text, so a prefix `1.2.3` also covers `1.2.30`; end a version prefix with the
    space before the hash (`1.2.3 `) or use `exact`. The node renders the target only from a version
    that looks like one, so the version cannot carry a space and a hash of its own.
- A Passkey or FIDO key signs in the WebUI, which crhs serves: that path cannot let the signer check
  the spec independently, and a compromised crhs could show one spec and ask for another. `crhu` with
  an SSH key can: it decodes the spec the payload binds, recomputes its hash and shows every field
  before signing ([Signing methods](#signing-methods)).

## Authorizations

An authorization is a signed payload that names the nodes it addresses, an optional command limit,
an issue time, a deadline, and optionally the tasks it is for. All its signatures cover the same
payload, so signers can never disagree about what they approved. crhs's cosignature is not one of
them: it is a separate cosign ticket that names the payload by its hash ([Cosigning](#cosigning)). The
encodings are in [Authorization object](protocol.md#authorization-object) and
[Cosign ticket](protocol.md#cosign-ticket).

While a task waits, its stored authorization record holds the planner's options: each `sign` option
carries the exact payload bytes to sign and the complete task spec they bind, so the same bytes survive
a crhs restart and stay as they are while they still ask for the same thing
([The planner](#the-planner)). Both are served only to the task's owner; every other task view shows the
options without them.

- **Deadline.** Every authorization must have one. A node refuses one without a deadline, crhs refuses
  to store it, and crhu refuses to sign it, because there is no revocation: an authorization
  without an expiry could be used forever ([Revoking trust](#revoking-trust)). A trust entry can also
  cap the lifetime with `max_ttl`.
- **Nodes.** Node UUIDs, node group UUIDs, or `*` (every node that trusts the signer). Names are
  resolved before signing, so renaming does not affect issued authorizations. A node accepts an
  authorization that names its own id or one of its [trust aliases](#trust-aliases).
- **Command limit.** `spec` binds one complete task spec by its `spec_sha256`, the hash of the
  canonical CBOR spec, so the method, target, environment, working directory, input content, mode and
  owner are all covered. The method and target follow from the spec, so the command carries only the
  hash; the signer supplies the spec and checks the hash with `crhu --spec`. A file plane transfer's
  endpoint (which data connection crhs accepts) is routing and is left out, so one group authorization
  covers members with different transfer ids. `prefix` binds only the method and a target prefix, not
  input, content, mode or owner. No limit means any command.
- **One-shot or reusable.** A one-shot authorization lists task ids and an attempt number and is valid
  only for those tasks; a reusable one is valid for any matching task until its deadline. Scheduled
  tasks and authorizations pre-signed with `crhu grant` rely on reuse. crhs authorizations and every
  approval of a specific task are one-shot, and a cosign ticket confirms specific uses.
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
devices with limited flash endurance, with the same trade-off after every restart. Moving `state_dir`
to another directory starts with an empty used list, with the same trade-off.

The state directory must belong to the privileged mode's user, must not be writable by group or
others, and no parent may be writable by the unprivileged account; otherwise the privileged mode
refuses to start. crha owns `/var/lib/crha`, so the default is `/var/lib/crha-privileged`, beside it.

### Signing methods

| Signer | Form | Where it is signed |
|---|---|---|
| crhs | SSHSIG with an Ed25519 key | Inside crhs |
| User SSH key, including FIDO keys | SSHSIG | On the user's workstation with `crhu sign`, which calls `ssh-keygen -Y sign` |
| User Passkey | WebAuthn assertion over the payload | In the WebUI |

SSHSIG was chosen because users already have SSH keys and agents, `ssh-keygen` handles encrypted keys,
agents and FIDO touch, and any authorization can be checked by hand with `ssh-keygen -Y verify`.
crhu never reads the private key.

A `spec` command limit carries only the hash, so `crhu sign` takes the spec as `--spec` (base64 of the
canonical CBOR spec, or `--spec -` for a large one): it recomputes the hash, refuses a mismatch, and
shows every field, the method and target the node would match included. `--content` hashes a local file
and matches it against the spec's input, so the signer checks the bytes as well as the spec.

Registering an SSH credential proves possession: crhs issues a short-lived, single-use challenge in
the separate `crh-register-v1` namespace, and the user signs it with the key. crhs takes the public key
from the SSHSIG itself, so a public key alone can never be registered for someone else. The challenge
names the user and the crhs installation and carries 32 random bytes; a registration signature never
verifies as an authorization, and an authorization never verifies as a registration. The challenge is
consumed on the first verification attempt, valid or not, and expires after ten minutes. Passkey
registration already proves possession through the authenticator's attestation.

Only the owner can rename or delete a credential (`PATCH` and `DELETE /api/me/signing-credentials/{id}`;
another user's id is a 404). A rename changes only the display name, audited as
`signing_credential.renamed` with the old and new name: nodes trust the key, so their trust entries and
the authorizations the credential signed are unaffected, though a generated trust entry keeps the name
it was generated with.

A `sign` option may carry the fingerprints of the owner's SSH credentials that match its user entries.
They are a selection aid for `crhu sign --hint`, not a trust decision: the planner decides exactly as
before, and the node verifies the signature against its own trust configuration.

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
| `local` | Local uids, opening the window with `crha approve --for` | Opens the window; no task limits |

`execute` lets a signer authorize a task alone. `cosign` lets crhs confirm a user authorization that
requires it, and `require-cosign` makes a user's authorizations need that confirmation. crhs's two
capabilities are independent: an entry with only `cosign` means crhs can never authorize alone, and no
crhs entry means crhs takes no part in privileged tasks. Only crhs can cosign, so users cannot cosign
for each other.

An entry can also limit what it authorizes: guard rules, an environment allowlist, a maximum lifetime,
`spec`-only (`require_spec`), one-shot only (`require_task`) and user verification (`require_uv`).
A `local` entry has none of these: it only lists `uids` and a `max_window`. The other limit fields are
configuration errors on it, because an open window waives every such limit.

The configuration must belong to the privileged mode's user and not be writable by others. Unknown
keys, duplicate names, and a key or credential id used by two entries are errors.

### Guard rules

Guard rules are a filter, not a rule engine. Each rule names a method and optionally a target `prefix`
or an RE2 `regex` that must match the whole target; with neither, it matches every target of its method.
`deny` rules are checked first and any match refuses; then, if `allow` rules exist, one must match.

| `allow` | `deny` | `env_allow` | What the entry accepts |
|---|---|---|---|
| empty | empty | empty | any target, any environment |
| empty | rules | | anything the deny rules do not match |
| rules | | | only what an allow rule matches, minus what a deny rule matches |
| | | names | only tasks whose environment variables are all listed |

An empty list places no limit, the same for all three: a trust entry restricts only what it states.

- A `file.write` allow rule also allows reading the same paths; a `file.write` deny rule blocks only
  writes, as in crhs rules.
- Rules constrain the target only, not input or content: allowing `exec bash` allows any script. Use
  a `spec` authorization when content matters.
- `PATH` is always fixed. Other variables are allowed until `env_allow` lists some, and variables such
  as `LD_PRELOAD` or `BASH_ENV` change what a command does without changing its command line. An entry
  whose guard rules matter should therefore list the variables it needs in `env_allow`; with none
  listed, its command rules can be bypassed through the environment. `env_allow` matches whole names:
  there is no wildcard, and `*` is a variable name like any other.
- A refusal names the entry and, for the environment, the variables it does not list, and says how to
  go on: run the task without them, or have the node's administrator list them. crhs shows the same
  text when it plans the task.
- The node is the authority on regular expressions. crhs evaluates the same rules only to plan, and a
  pattern it cannot compile is treated conservatively (allow does not match, deny does).

### Cosigning

With `require-cosign`, every use of a user's authorization also needs crhs's confirmation of that use:
a cosign ticket that `task.start` carries beside the authorization. crhs cannot run the task alone, and
the user cannot bypass crhs rules.

- **What a ticket confirms.** A ticket names the authorization by its id (the payload's SHA-256) and
  lists the uses it confirms, each a node UUID, a task id and an attempt. The node accepts it only for
  its own node, this task and this attempt, within the ticket's short deadline (five minutes). A ticket
  is signed in its own SSHSIG namespace, `crh-cosign-v1`, so it can never pass as an authorization
  signature, nor the reverse.
- **One-shot and reusable alike.** Because the ticket binds the use, the authorization it confirms may be
  reusable: a 5-minute grant or a `crhu grant` authorization still runs only the tasks crhs confirms,
  each one separately. A crhs signature on the user's payload is never a cosignature.
- **One ticket per dispatch.** crhs signs a ticket when it sends tasks: the uses a task group sends
  together share one ticket, with one signature per crhs key the nodes trust to cosign; each node finds
  its own use and ignores keys it does not trust. When that ticket would not fit beside the
  authorization in half a frame, each node gets a ticket with its own uses. A retried task gets a new
  ticket for its new attempt.
- **No extra limits.** A ticket confirms one use of what the user signed rather than authorizing on its
  own, so the crhs entry's other limits (guard rules, `require_spec`, `max_ttl`) do not apply to it.
- **Nothing stored.** The authorization is stored as the user signed it; each ticket is recorded only in
  the audit log (`authorization.cosigned`, with the ticket's uses and keys).

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

1. **Peer.** The caller's uid is the unprivileged mode's, or a local approver's for the window
   commands.
2. **Task.** File paths satisfy [Methods and targets](#methods-and-targets).
3. **Signatures.** Each signature is matched to a trust entry by key and verified. Signatures for
   other nodes' entries are ignored; one that matches an entry but fails verification invalidates the
   whole authorization. Each matching `crhs` or `user` signature is a candidate for steps 4–8; the
   first candidate that passes wins.
4. **Body.** The authorization addresses this node, is not issued in the future, has a deadline that
   has not passed, and respects `max_ttl` and `require_spec`, all within the clock tolerance.
5. **One-shot.** The task has not run before and the authorization is newer than the watermark. A
   one-shot authorization lists this task with the same attempt and has not been used for it. crhs
   authorizations and `require_task` entries must be one-shot.
6. **Command limit.** `spec` matches the task's complete-spec hash; `prefix` matches method and
   target prefix.
7. **Entry.** The entry can `execute`, its guard rules and environment allowlist pass, and user
   verification is present if required.
8. **Cosignature.** If the user entry requires it, the cosign ticket confirms this task at this attempt
   on this node for this authorization, has not expired, and carries a valid signature of a `crhs`
   entry with `cosign`. A ticket signature by a trusted key that does not verify invalidates the
   ticket.

When the local approval window is open at validation time, step 4 skips `max_ttl` and `require_spec`
for a crhs signature, and step 7 is skipped entirely: the entry does not need the `execute` kind, its
guard rules do not apply, and its environment allowlist does not apply. The signature must still
verify, the body checks in step 4 still apply (addresses this node, not issued in the future, deadline
not passed), the one-shot and used-list checks in step 5 still apply, and the signed command limit in
step 6 still applies, because that is what crhs signed. The window never applies to a `user` signature.
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

## Local approval window

A local administrator logged in to the node runs `sudo crha approve --for 30m` to open a time-limited
window. The command talks directly to the privileged mode's socket; crhs is not involved and no key is
needed. `crha approve` without `--for` prints the current state, and `sudo crha lock` closes the window
early.

A window is node trust state, not an answer to one task: opening it releases every privileged task
waiting on the node, for every user and every task group, and crhs sends each of them with its own
signature at once. `crha approve --for` says so when it opens the window.

While the window is open, a task authorized by crhs's own signature runs on this node without the
node's other limits: no guard rules allow or deny it, the environment allowlist does not apply,
`max_ttl` and `require_spec` do not apply, and neither does the `execute` kind of the crhs entry. This
is deliberate: it lets crhs repair or reconfigure the node, including writing `/etc/crha/`. It is
equivalent to temporarily handing the privileged identity to crhs, like a sudo timestamp. The window
closes when it expires, when `crha lock` runs, or when the privileged mode restarts; it lives in memory
only. Opening it again replaces the current window.

The window length must be positive and at most the `max_window` of the local entries that list the
caller's uid (one hour by default). The configuration does not keep `unprivileged_uid` out of `uids`:
listing it lets `crha run`, and so any task crhs sends, open the window, which hands crhs the
privileged identity whenever it asks. That is a valid choice for a node that fully trusts crhs, and it
is the administrator's to make. A node with no `crhs` entry cannot use a window at all: there is no
key with which to verify crhs's signature, and `crha approve --for` refuses.

While the window is open, a crhs authorization still has to verify, address this node, be issued and
not expired, respect the one-shot and used-list rules, and match its own command limit. Those checks
are the authorization crhs signed, not node policy. A window covers task groups as well; it is node
trust state, not a task decision.

The node reports the window in its trust summary and pushes a new summary when it opens or closes
(including expiry), so crhs syncs the waiting tasks. The window is also recorded in the local log:
opening (uid, until), closing (uid or expiry), and every task accepted through it.

crhs never compares the window's times, which are the node's clock, with its own. A window counts as
open until the node reports it closed, and its `openedAtMs` serves only to tell one window from the
next. Clock differences and the time a push takes are not handled: when crhs sends a crhs signature
for a window that has just closed on the node, crha refuses it, and that refusal is handled like any
other.

Known issue, low priority: crhs records a refusal of its own signature under the window the node
reports after the refusal. A window opened between the refusal and that report is recorded as the one
that refused, so crhs does not sign that task again under it; opening the window once more (a new
`openedAtMs`) lets it. Fixing it would need crha to report the window it decided under.

To gate one task instead, use a user-signed `spec` authorization: a window is a deliberate,
time-limited trust decision, not a per-task approval.

## Waiting for signatures

A task that passed its rules but needs a signature is `awaiting_authorization`, distinct from
`awaiting_approval`. Approval waits never expire, but a signature wait ends the task as `expired`
with `authorization_wait_expired` after 24 hours, the same as the default lifetime of an owner's
authorization. The owner can also reject the wait with a reason: the task ends `rejected` with
`authorization_declined`, because that is an explicit decision. The code is not crha's
`authorization_rejected`, so a task the owner turned down is never mistaken for one the node refused. Stopping a session, or a session's run
ending, cancels the waits of the tasks it created: those tasks end `cancelled`
([Session state](agent-runtime.md#session-state)).

A task whose plan offers a `local_window` option carries only the node id and name: the WebUI and
the chat card render the `sudo crha approve --for 30m` command themselves, and the WebUI shows the
window state from the node's trust view. Opening the window pushes a trust summary that syncs the
task; if no window opens, the wait expires like any other authorization wait. A task group is never
offered a `local_window`: its members can only be released by a signature.

The owner sees every option on the approvals page, the task page or the session's tool card: a
`sign` option is the signature panel (a Passkey, `crhu sign` or the `ssh-keygen` recipe, and the
5-minute reusable twins of the first two when the nodes accept one), a
`local_window` option is the command block, and Reject is always available. A task whose options are
not written yet shows "Preparing…" in the WebUI and gets no chat card until they are; a planned task
always has at least one option.
The owner signs from the approvals page, the task page or the session's tool card, and may reject the
wait from the same places or from the chat (`/reject` or the card's Reject button). A task group's
signature wait counts once; a partly dispatched group still shows it while any member is in
`awaiting_authorization`, even though the group itself is `running`. Rejecting a partly dispatched
group ends its waiting members; the members already sent run on, and a member that crha refuses
afterwards is rejected too instead of asking anew.

## Revoking trust

There is no revocation of individual authorizations. To withdraw a signer, remove or replace its trust
entry in `privileged.toml` and reload the privileged mode. Running tasks continue; later tasks are
checked against the new configuration. A reload also closes an open local approval window when the
node lost its `crhs` entry or the opening uid is no longer in a `local` entry; `crha lock` closes one
immediately.

A revocation list was rejected because crhs would distribute it, and crhs is exactly the party that
cannot be trusted when revocation matters. A node also sees only the authorizations addressed to it,
and revocation cannot reach an offline node. Instead, one-shot authorizations cannot be replayed, and
reusable ones are bounded by their command limit, guard rules and deadline.

## Server-side authorization

crhs plans an authorization path from the trust reports nodes send, but planning is only a preview:
the node re-checks everything against its current configuration. A planning mistake in crhs can only
cause waiting or a refusal, never extra privilege. crhs considers only the task owner's signing credentials,
never those of users the session is shared with.

### Trust cache

The privileged mode reports its trust configuration to crhs after connecting and whenever it changes.
crhs never asks for it. Before forwarding an authorization refusal, the unprivileged mode refreshes the
report, so crhs plans its retry from the node's current state. A change is recorded in the audit log.

crhs plans from the last report it stored, whichever connection sent it. Whether that report is still
current is not tracked: crha decides, and a refusal is handled like any other. A node that never
reported leaves its tasks waiting with no options until its first report; a report that says the
privileged mode is unavailable ends them `errored` with `privileged_unavailable`. A trust report whose
digest changed, and the first report on a new connection, sync the node's waiting tasks, so a
signature submitted while the node was away is used when it reconnects.

Authorizations submitted by users are stored for reuse after crhs checks their deadline, and are
removed by retention after they expire. A submission only verifies and stores the authorization
synchronously; the sync it requests does the claiming, the cosign tickets and the sending. Submitting a payload the
owner already stored adds its new signatures (another key, a Passkey with user verification) to that
row, so signing again is not lost and still counts as one signature. A Passkey submission carries the
payload bytes the browser signed, so a payload a pass replaced while the owner was signing still
verifies. The authorization id is
the payload's hash, so a payload another user already stored (or crhs signed) is refused, and that
row is left alone.

Methods, guard match types, trust roles and capabilities are open names
([Encoding rules](protocol.md#encoding-rules)): a node of a newer minor may report values this crhs does
not know, and the report still decodes. crhs plans around them conservatively and the node decides:

- A guard rule with an unknown method applies only to that method, so it matches no task crhs plans.
- A guard rule with an unknown match type is treated like an uncompilable pattern: an allow rule never
  matches, a deny rule matches every target of its method.
- A trust entry with an unknown role or capability is not used to plan, because an unknown capability
  might restrict what the entry allows.
- Such an entry gets the `trust_newer_values` warning, which names the unknown values.

On the node, an authorization whose `prefix` names a method the node does not know covers nothing, and
`privileged.toml` itself still refuses an unknown method: it is local and matches the binary reading it.

A user who wants a reusable authorization without `crhu grant` asks crhs to draft one:
`POST /api/authorizations/draft` takes nodes or node groups (each node must be in the user's reach),
a method and prefix or no limit, a lifetime of at most a year and a note, and returns the payload
bytes and their WebAuthn challenge without storing anything. The user signs those bytes with a
Passkey and submits them like any other authorization. `GET /api/authorizations` lists the whole
organization's authorizations to administrators and only their own to other users.

### The planner

Authorization planning is one pure state machine (`server/src/privilege/planner.ts`). It performs no
I/O and holds no prose: its input is either one task or a whole task group, the trust summaries of
their nodes (including the `localWindow` state), crhs's own signing keys and the owner's stored
authorizations. Its output is exactly one of:

- **usable**: authorizations that may be claimed and sent now — crhs's own signature (an open local
  window counts, as the node's own decision does), or a stored owner authorization the node would
  accept, with crhs's cosign ticket when the entry requires one. Only a task whose node is connected is
  ever usable: a task.start to an absent node would only wait out its grace;
- **options**: the ways the owner could authorize, plus the tasks that have no option at all;
- **failure**: no usable path and no known option.

The planner judges with the same decision port the node runs (`authz.ts`), so it cannot pick a path
the node would reject. A plan is still only a prediction: crha re-verifies everything before
executing, and a planning mistake can only cause waiting or a refusal, never extra privilege.

An option is one of:

- `sign`: a user-signature path — the accepting trust entries, their credential kinds, whether a
  cosignature is available or missing, and the payload's lifetime — with the exact payload bytes to
  sign and the complete task spec they bind (a task group's spec for a group), so `crhu sign --spec`
  can check the hash. A task group gets one shared payload covering all of its waiting members, at the
  highest of their attempts. The bytes and the spec are stored on the task and kept while they still ask for the same thing:
  the same tasks at the same attempts, accepted by the same entries, and not yet due for a refresh
  (a quarter of the payload's lifetime before its deadline, at most a minute). The owner may be
  signing them at that moment, so a pass that changes nothing writes nothing. A user entry whose
  `max_ttl` is under a minute is treated as absent: its payload would leave no time to sign. crha
  itself refuses a `max_ttl` under five minutes, so only an older node can report one.
- `local_window`: only for one single task whose node has a `local` entry with uids and trusts one
  of crhs's signing keys. It carries just the node id and name; the surfaces render the command
  text. A task group is never offered a window.

A unit (a task group, or a task in none) asks its owner for at most two signatures. An owner
authorization stored since the unit was created that names every one of its waiting tasks (or their
nodes) and its command counts as one, whatever crha made of it. Once two exist, the planner offers
no `sign` option: a third signature would meet the same refusal.

What a crha refusal rules out is kept on the task. A refused crhs signature rules out crhs's own path
while the node reports the same local window (none, or the same `openedAtMs`); a new window makes it
usable again. A refused owner authorization rules out every owner authorization stored up to it: the
planner uses the newest stored authorizations first, and only ones stored after the refused one are
used for the task again. So nothing crha refused is sent again, and the number of sends is bounded.

A task on an absent node is not kept waiting for its node. If a stored owner authorization covers
it, it waits with the `awaiting_node` marker (the owner has nothing left to do; the surfaces say it
is sent when the node is back), and the node's next report sends it. If the owner can still sign, it
waits with its `sign` option like any other task. Otherwise it ends `errored` with `node_offline` at
once, even when crhs could sign it once the node returned: a quick answer lets the agent that asked
for it go on, which matters more than waiting for a node that may not come back.

A task with no usable path and no option fails at once: `rejected` with the last crha code (or
`authorization_required` when nothing was ever refused), keeping the last rejection message from
crha when there is one. A reusable authorization blocked only by a missing node group alias ends
`errored` with `alias_missing` instead.

### Authorization path

For a privileged task, crhs:

1. Applies its rules ([Authorization rules](access-control.md#authorization-rules)). A user acting
   directly in the WebUI skips them.
2. Applies the node's mode: `native` and `ignore` need nothing more, `reject` refuses, and `forward`
   continues.
3. Moves the task to `awaiting_authorization` with no options yet and syncs its unit: the task, or
   its whole task group.

A sync pass reads the unit's waiting tasks as they are, plans them once for the owner, and acts on
the one result:

- **usable**: claim every usable task first, then send each `task.start` without waiting for the
  answers. A crhs signature is a one-shot `spec` authorization with a short deadline (five minutes
  by default); a stored owner authorization is reused as stored, and the uses whose nodes require a
  cosignature get crhs's cosign ticket, signed once the claims fix their attempts. Tasks the result does
  not cover are planned by the next pass.
- **options**: write the options on each waiting task's record. A `sign` option arms a timer that
  syncs the unit again when the payload is due for a refresh.
- **failure**: end the tasks `rejected` with the last crha code and message, or `errored` with
  `alias_missing` when only a missing node group alias stands between a stored reusable
  authorization and the node.

Every write checks the row's revision as the pass read it. A task that changed in the meantime is
left alone, and the pass asks for another one instead of retrying itself. A pass only ever raises a
waiting task's attempt, to the one its group's shared payload carries; a task that was claimed, sent,
or ended is no longer read by any pass, so nothing a pass writes reaches it.

Passes run through one `KeyedReconciler` keyed by unit ([Concurrency](architecture.md#concurrency)):
passes of one unit never overlap, and the requests made during a pass fold into one more pass that
reads newer rows. Every event only requests a sync of the units it concerns; there is no second
dispatch path:

- the first dispatch of a task (step 3), and a member of a task group entering the wait;
- a trust report whose digest changed, and the first report on a new connection, for the node's
  waiting units. A local window opening or closing changes the digest, so it syncs them too;
- a submitted authorization, for the submitting user's waiting units it may cover. Units on a node
  that is away are not waited for: the node's next report syncs them;
- a node refusing an authorization: crhs records the refusal and what it rules out, advances that
  task's attempt and syncs its unit;
- a `sign` payload due for a refresh, by its timer, and the periodic sweep (and the one at startup)
  for waits whose timer died with the process or that have no options yet.

Code inside a pass or inside a task turn only requests a sync and never waits for one: a pass
waiting for its own unit would wait for itself.

A task group syncs as a unit: one planner call produces one overall plan or one set of options for
the frontend. Members that no longer need authorization are not read and never touched. When crha
refuses one member, that member waits again at the next attempt, and the group's next payload covers
it together with the members still waiting, at that attempt.

When the nodes of a task group trust Passkeys for different sites, the group payload is the same for
all of them; a signature releases the nodes that accept it, and the next pass plans the rest.

Tasks that already ran are not rolled back.

### Authorization signing key

crhs keeps a list of Ed25519 signing keys, each identified by its SSH fingerprint, stored encrypted
with the master key. It creates one on first start; administrators can add and delete them while crhs
runs. A node trusts the keys it lists as `crhs` entries, with `execute`, `cosign` or both. For each
node crhs uses the newest key that node's cached trust report trusts with the needed capability, so
during a rotation a node that has not reloaded yet keeps working with the key it knows. A cosign ticket
for a task group's uses carries one signature per key its nodes need; each node ignores signatures that
match no trust entry.

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

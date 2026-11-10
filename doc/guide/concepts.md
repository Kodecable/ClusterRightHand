# Concepts

ClusterRightHand (CRH) runs agent sessions on a server and dispatches the work they decide on to
managed hosts. This page defines the objects and terms you meet in the WebUI, the API and the
configuration files. It is a map, not a specification: every section links to the design document
that describes the mechanism in full.

## Organization

CRH is built for one organization with several users. The server creates a single organization
named `default` on first use and has no multi-organization feature: users, nodes, sessions, tasks,
schedules, tokens and audit events all belong to that organization. Organization-scoped tables carry
an `org_id` column so that the boundary is explicit in storage, but there is no way to create a
second organization or to move an object between organizations. See [Users and
ownership](../design/access-control.md#user-model).

## Users and user groups

A user is a person who signs in to the WebUI. A user has a username (lowercased and unique), a
display name, an optional email address and a local password. Password login is the only login
method. A user's signing credentials — an SSH public key, including a FIDO hardware key, or a
Passkey — are used only to sign privilege authorizations, never to sign in; see [Signing
methods](../design/privilege.md#signing-methods).

A user group is a named set of users maintained by administrators. It is used for two things: to
share a session with several people at once, and to grant node access to several people at once.
Membership changes apply immediately. User groups do not nest and are not a role system: being in a
group grants exactly what the group has been granted, nothing more.

## Administrators and members

There are no roles and no fine-grained permissions. The only distinction is the user kind:
administrator (`admin`) and regular member.

| Kind | What it may do |
|---|---|
| Administrator | Everything a member may do, plus manage users and user groups, configure model providers and model presets, and manage nodes, node groups, SSH credentials and node access grants. An administrator sees every node and every session and the whole audit log. Another user's session is read-only by default: the administrator cannot change its rules or decide its approvals, may chat only after an explicit `chat` share, and may list and revoke its shares but not create one. |
| Member | Manage their own sessions, scheduled tasks and API tokens; see and operate the nodes granted to them or to one of their user groups; use sessions shared with them; see the audit events recorded on their behalf. |

An administrator cannot change their own kind or disable themselves, and the server refuses a change
that would leave the organization without an active administrator. Disabling a user ends their WebUI
sessions, makes their logins and API tokens fail, and disables their scheduled tasks. See [User
types](../design/access-control.md#user-types).

## Nodes

A node is one managed host. CRH has two transports:

- **crha client.** The node runs the `crha` binary. It dials crhs over WSS, completes a Noise
  handshake, executes ordinary tasks as its own Linux identity and reconnects with backoff after a
  network break. The connection carries heartbeats, task output and resumable output offsets. A
  privileged task is handled according to the node's privilege mode.
- **SSH.** The node runs only an sshd; there is no `crha` and nothing to install. crhs connects out
  to it, optionally through jump hosts, authenticates with a credential generated in crhs and pins
  every hop's host key. Tasks run as the SSH user. File tasks need the SFTP subsystem. There is no
  standing connection and no privileged execution: the `privileged` flag is ignored.

A node belongs to the organization and is managed by administrators; users reach it through a node
access grant. A crha node is `pending` from enrollment until an administrator approves its key
fingerprint, then `active`. Whether a node is online is derived from its connection, not stored: a
crha node is connected or offline, while an SSH node has no standing connection and is shown as
active, with its last-seen time coming from the last task that reached it. See [Node
registration](../design/protocol.md#node-registration) and [SSH
transport](../design/execution.md#ssh-transport).

## Node groups and names

A node group is a named set of nodes used to select nodes (in a rule's `nodes`, a task target or a
node access grant) and to grant access to several nodes at once. A group contains nodes only, does
not nest, and may contain crha nodes and SSH nodes together. Membership is maintained in crhs and
applies immediately; `crha.toml` has no groups key.

Nodes and node groups share one namespace per organization, so a node and a node group cannot have
the same name, compared case-insensitively. Both have an immutable UUID, and every internal
reference — a rule's `nodes`, a node access grant, a task group's targets — stores that UUID. Names
are input and display only: renaming changes one field and rewrites no reference, while deleting an
object and recreating one with the same name produces a new UUID that old references do not match.
Names starting with `_` are reserved for the system; the only such name is `_all`, which means
every node the acting user can access. See [Node groups and
names](../design/access-control.md#node-groups-and-names).

## Node access grants

An administrator grants a user or a user group access to a node or a node group. There is one level:
view and execute, which lets the grantee see the node and its facts and run tasks on it, including
privileged tasks. A grant on a node group is dynamic: a node added to the group becomes available to
the grantee, and a node removed from it stops being available.

A node the user cannot access is invisible rather than forbidden: it is absent from lists and
selectors, and a request by id returns 404. Whether a task is visible depends on the user's relation
to the task, not on current node access. A node access grant and privilege trust are independent: the
grant decides whether crhs lets the task start, while a `forward` node still applies its own trust
configuration to a privileged task. See [Ownership, access grants and
sharing](../design/access-control.md#ownership-access-grants-and-sharing).

## Tasks and task groups

A task is one execution on one node. The server generates its `task_id` as a UUIDv7, the node is
fixed for the task's whole life, and the task kind is one of `exec`, `file.read`, `file.write`,
`file.edit`, `file.stat` or `file.list`.

A task group is one call over several targets: one task per node, with independent results. A group
targets at most 512 nodes after expansion and de-duplication, runs with bounded parallelism (10 by
default, at most 100), and is approved once as a whole. A member that fails does not roll back a
member that already ran.

A task moves through these states:

| State | Meaning |
|---|---|
| `awaiting_approval` | Waiting for a person or an agent to approve it under the rule chain. |
| `awaiting_authorization` | Allowed by the rules, but a privileged task on a `forward` node is waiting for a signature or a local approval. |
| `dispatched` | Sent to the node and not yet confirmed as running. |
| `running` | Accepted and executing on the node. |
| `exited` | The command or file operation ran and reported an exit code. |
| `failed` | It could not complete; an error code and message say why. |
| `rejected` | A person, a cancellation or an expired wait refused it. |
| `denied` | A rule refused it before dispatch. |
| `unknown` | The server lost track of it: the connection dropped, the client restarted, or dispatch was never confirmed. |

The terminal outcome is the state plus its detail: `exited` carries the exit code (a non-zero code is
still `exited`), `failed` carries an error code, `rejected` and `denied` record the deciding person
or rule, and `unknown` carries a reason. A cancelled task has the `cancelled` flag set; if it was cancelled
before dispatch it ends as `rejected` with the error code `cancelled`. A task group ends as
`finished`, `interrupted`, `rejected` or `cancelled`, and may pass through `awaiting_approval`,
`awaiting_authorization` and `running`. See [Task model](../design/execution.md#task-model), [State
machine](../design/execution.md#state-machine) and [Task groups](../design/execution.md#task-groups).

## Privileged tasks

A privileged task is a task whose spec sets `privileged = true`. "Privileged" means "needs an
authorization to execute", not "runs as root": a node can run its privileged mode as an ordinary
user, and an unprivileged mode can run as root. How a node handles the flag is its privilege mode,
set in `crha.toml` and reported to crhs. The default is `reject`.

**Forward.** The unprivileged mode forwards the task, with its authorization unchanged, over a local
Unix socket to a separate privileged-mode process. That process verifies the authorization against
its own `privileged.toml` trust configuration, executes the task under its own identity and relays
the output back. This is the only mode that is a security boundary: a node that trusts only user
signatures or local approval cannot be made to execute a privileged task by a compromised crhs.

**Native.** The unprivileged mode starts the same binary as a short-lived helper through `sudo -n`,
`doas -n` or `run0`, and the helper executes the task under the target identity. The helper checks no
authorizations, so only the crhs rules constrain it. Native mode obtains an identity
non-interactively; it is not a security boundary, because permission to run the helper without a
password is already equivalent to having that identity.

**Ignore.** The unprivileged mode ignores the flag and runs the task under its own identity. Only the
crhs rules constrain it. It is common when the unprivileged mode itself runs as root.

**Reject.** Every privileged task is refused. This is the default for a node with no `[privileged]`
table.

An SSH node is treated like `ignore` for the flag, with an output notice: the task runs as the SSH
user. See [Privilege modes](../design/privilege.md#privilege-modes) and [The privileged
mode](../design/privilege.md#the-privileged-mode).

## Rule chains and approvals

Authorization rules decide whether an actor may start a task. A user acting in person in the WebUI
has no rule chain: only node access is checked. A rule chain starts at an object that acts for a
user:

| Root | Chain |
|---|---|
| Session | Root session → child session → … |
| Scheduled task | Schedule → the session created for the run → child sessions |
| API token | The token itself, for MCP calls |

A root is configured by a rule preset — Ask, Auto Review or Yolo — which supplies the root's default,
plus any rules added on top. Ask allows non-privileged reads and sends everything else to the user.
Auto Review uses the same rules but sends an approval that would go to the user to the review model
first. Yolo allows by default. A child session receives a complete rule set from its parent and can
only tighten the level above; the API rejects a rule preset for a child. API tokens may use only Ask
and Yolo.

Each level produces its **own result**: the strictest matching rule (`deny` beats
`require-approval`, which beats `allow`), or the level's `default` when no rule matches. The
**cumulative result** is computed from the root down: start with the root's own result, then for each
later level keep the stricter of the previous cumulative result and that level's own result, where
`inherit` and `allow` add no restriction. The last level's cumulative result is the decision. A
lower `allow` therefore cannot widen a restriction set above it; it is useful only together with a
lower `default` of `deny` or `require-approval`.

When the cumulative result is `require-approval`, the request walks up the chain from the level that
raised it to the first ancestor whose effective result is `allow`. That ancestor's agent may approve,
reject or escalate. If no ancestor allows, or the agent escalates, the root's owner decides in the
WebUI — unless the root preset is Auto Review, in which case the review model decides first. An
approval is stored on the task, or once on the task group, and has no deadline. Changing the rules
re-judges every waiting task on the chain. See [Rule chain](../design/access-control.md#rule-chain),
[Evaluation](../design/access-control.md#evaluation) and [Approvals](../design/access-control.md#approvals).

## Authorizations and signatures

An authorization is a signed permission for a privileged task. It is separate from a rule approval:
a rule approval decides whether crhs lets the task start, while an authorization is what a `forward`
node verifies before it executes anything.

An authorization is a CBOR payload plus a `signatures` array. The payload names the nodes it is
addressed to, an optional command limit (`exact` or `prefix`), `issued_at`, a mandatory `deadline`,
and optionally the task ids and attempt that make it one-shot. A one-shot authorization is valid for
the listed tasks only; a reusable authorization is valid for any matching task until its deadline.
The signatures come from the crhs signing key, a user's SSH key (signed with `crha grant` on the
user's workstation) or a user's Passkey (signed in the WebUI). Separately, a node may approve a task
locally without a signature. Every executed task is recorded in the node's used list before it
starts, so a one-shot authorization cannot be replayed.

A task waiting for a signature is `awaiting_authorization`, not `awaiting_approval`. A signature wait
expires after 24 hours and ends the task as `rejected` with `authorization_wait_expired`. When a node
trusts only a user signature, that signature also counts as the crhs approval, so the user does not
approve twice. See [Authorizations](../design/privilege.md#authorizations), [Waiting for
signatures](../design/privilege.md#waiting-for-signatures) and [Authorization
object](../design/protocol.md#authorization-object).

## Sessions, subagents and model presets

A session is a conversation with the agent, owned by the user who created it. It is created with its
first message, stores a durable transcript and has a run state of `idle`, `running` or `awaiting`
(for an approval, a signature or a quota decision). Sharing a session does not change whose identity
it acts under: a shared message still runs as the owner.

A subagent is an independent session below a parent session. It has its own rule set, optional token
quota and run state, and it shares the owner of its tree. Subagents nest at most two levels below a
root. The parent chooses the child's rules and quota at creation, and a child can only tighten the
level above.

Model presets are administrator settings, not per-session models. There are three: Session (an
optional system prompt), Auto Review (the model and thinking level used by the review step, plus a
prompt) and Title generation (the model used to name sessions, plus a prompt). Each session chooses
its own model from the configured providers. A session may also carry an optional token quota; when
a level is exhausted, the run pauses and asks the direct parent, or the owner for a root, to add
tokens or stop. See [Sessions](../design/agent-runtime.md#sessions), [Model
presets](../design/agent-runtime.md#model-presets), [Subagents](../design/agent-runtime.md#subagents)
and [Quota and token accounting](../design/agent-runtime.md#quota-and-token-accounting).

## Scheduled tasks

A scheduled task has one shape: on a timetable, it submits a fixed user message into a new session.
The schedule is the root of that session's rule chain, so its rule preset, approvals, privilege and
quota behave like an ordinary session's. The timetable is a five-field cron expression with minute
precision and an IANA time zone; `catch_up` decides whether one trigger missed during downtime runs
afterwards. Each run's session belongs to the schedule's owner and takes the schedule's name as its
title.

A schedule has at most one running instance: a new trigger ends the previous instance before it
starts, including one that is waiting for an approval, a signature or quota. Disabling the owner
disables the owner's schedules. See [Schedule model](../design/scheduling.md#schedule-model) and [One
instance at a time](../design/scheduling.md#one-instance-at-a-time).

## API tokens

An API token lets an MCP client act for its owner. It is `crh_` followed by 32 random bytes in
base64url, is shown once at creation and is stored only as a SHA-256 hash. A token has a name and a
lifetime: 90 days by default, at most 365 days, or no expiry when created without one.

A token authenticates only the `/mcp` endpoint and is the root of its own rule chain. It can use only
the Ask and Yolo presets, cannot perform administrative actions, and can access the same nodes as its
owner. Revoking a token, or letting it expire, rejects the tasks and task groups it started that are
still waiting for approval. See [API tokens](../design/access-control.md#api-tokens).

## Audit

Every mutation that matters is appended to `audit_events`. Each event has a database-assigned `seq`,
a timestamp, an actor, an action, an optional target and a JSON `detail` object. An administrator sees
every event; every other user sees the events recorded on their behalf. A task's or session's content
is not copied into the audit: the log holds metadata and references.

The server appends events and never updates one; only the retention sweep deletes them. There is no
hash chain, so tamper evidence depends on exporting the log. The newest 16384 sequence numbers are
always kept, whatever the retention window. See [Audit](../design/access-control.md#audit) and [Data model:
audit](../design/data-model.md#audit).

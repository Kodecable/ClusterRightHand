# Users, ownership and audit

Access control in crhs has two layers: which users may see and use a node or a session, and which
operations an object acting for a user (a session, a scheduled task, an API token) may start. Trust
on the node itself is described in [Privilege](privilege.md).

## User model

crhs serves one organization with several users. Organization-scoped tables carry `org_id` from the
start, because adding the column later would touch every table and query. There is no
multi-organization feature yet; crhs creates a single organization on first use.

| Object | Meaning |
|---|---|
| User | A person who signs in to the WebUI with a local password. |
| User group | A set of users maintained by administrators, used to share sessions and grant node access. |
| Signing credential | An SSH key, FIDO key or Passkey used only to sign privileged-task authorizations, never to sign in. |
| API token | A user's credential for MCP clients; the root of its own rule chain. |
| Node | A managed host, owned by the organization and managed by administrators. |
| Node group | A named set of nodes, used to select nodes and grant access. |
| Node access grant | Gives a user or user group access to a node or node group. |

Nodes are organized by node groups rather than tags. Wherever a set of nodes is needed, the value is a
list of node and node group references. Node groups are crhs data: they contain only nodes, do not
nest, and are not configured on the node.

## User types

There are no roles and no fine-grained permissions, only two user types:

- An **administrator** manages users, user groups, model settings, nodes, node groups, SSH credentials
  and node access grants, and can see every node, session and audit event.
- A **member** manages their own sessions, scheduled tasks and API tokens, uses the nodes granted to
  them, and uses sessions shared with them.

An administrator can see another user's session but not act in it: they cannot change its rules,
decide its approvals or create shares for it, and can chat only after the owner shares it with them for
chat. Seeing everything is needed to administer the system; acting as another user is not.

Accounts that a caller may not see answer 404 like missing ones, so members cannot probe for accounts.
Any user can search the directory of users and user groups to share with; it returns names only.

An administrator cannot demote or disable themselves, and crhs refuses any change that would leave no
active administrator. Disabling a user ends their WebUI sessions, invalidates their API tokens and
disables their scheduled tasks.

## Node groups and names

Nodes and node groups share one namespace, compared case-insensitively. Both have an immutable UUID,
and every stored reference (a rule's nodes, a grant, a task group's targets) uses the UUID. Names are
for input and display only. Renaming therefore rewrites no reference, while deleting and recreating
an object with the same name produces a new object that old references do not match. Using the name
as the key was rejected because a rename would then rewrite rules, grants and history.

Names starting with `_` are reserved. The only reserved name is `_all`, which means every node the
acting user can access and is evaluated when used. The exact name syntax is in
`server/src/util/names.ts`. Default names derived from hostnames are normalized to that syntax and
made unique with a numeric suffix.

## Login, rate limiting and verification

Password login is the only login method. Before a password is verified, crhs checks the proof of work
(when enabled) and then the rate limiter, so neither a bad challenge nor a limited attempt costs an
Argon2id computation. All limits live in the crhs process and reset on restart.

All login failures (unknown user, no password, wrong password, disabled account) return the same
error, and an unknown user is verified against a dummy hash, so responses do not reveal which accounts
exist. The audit log records the actual reason.

### Client address

The client address is the socket peer address, or the first entry of a configured header such as
`X-Forwarded-For` when crhs runs behind a reverse proxy. There is no trusted-proxy list: the proxy must
overwrite the header, and crhs must not be reachable directly, otherwise clients can forge it. The
address is used for rate limiting, for the captcha scope and for the address stored on a WebUI
session ([crhs configuration](../guide/reference/crhs-config.md#listen)).

### Rate limiting

Failures are counted per address and per address and username. There is no username-only key, so an
attacker cannot lock out a user from elsewhere. A success clears only its own address-and-username key,
so a valid account cannot be used to reset the address while guessing other usernames.

An attempt is counted as a failure before the password is verified, and only one login per address may
be verifying at a time, so a burst of concurrent requests cannot slip past the limit. Limited attempts
are not audited, so brute force cannot fill the audit log. Password changes use the same scheme per
account.

### Password hashing

Passwords are hashed with Argon2id from `node:crypto`. Hashes with outdated parameters are upgraded on
the next successful login. Passwords are NFKC-normalized and limited in length.

Argon2id is memory-hard, so every hash computation in the process goes through one gate with a small
concurrency limit and a bounded queue; when the queue is full, crhs answers 503 at once. Logins may use
the whole gate, while other hash operations (password changes, resets, user creation) are held below
it, so a signed-in user cannot starve logins.

### Cap proof of work

By default a login must first solve a Cap proof-of-work challenge. The challenge is stateless (a signed
token valid for two minutes) and is bound to the client address, the username and a hash of the
password. Guessing another password therefore needs a new challenge and new work.

A challenge can be replayed, deliberately: replaying it repeats the same guess, which costs the
attacker a counted failure each time, so recording used challenges would add state without adding
protection. `captcha = "none"` disables the challenge for environments that cannot run a browser.

## Ownership, access grants and sharing

Nodes and node groups belong to the organization. Sessions, scheduled tasks and API tokens belong to
the user who created them; subagent sessions belong to the parent session's owner, and sessions
created by a schedule belong to the schedule's owner. Per-user node ownership was rejected because it
splits a cluster among owners, and sharing an SSH node would lend its owner's SSH credential.

A node access grant gives a user or user group access to a node or node group. There is one level:
see the node and run tasks on it, including privileged tasks. A read-only level was rejected because
running tasks is what a node is for, and read-only access would complicate the model without
protecting anything. A grant on a node group follows the group's current members.

- A node the user cannot access is invisible: it is missing from lists, and a request by id returns
  404, not 403.
- Task visibility depends only on the user's relation to the task, not on node access. Users see the
  tasks done on their behalf even after losing access to the node, and node access never reveals
  another user's tasks.
- Access is checked when a task is created and again before dispatch, after any approval or signature
  wait. A waiting task whose user lost access, or whose node was deleted, ends without running.
- A node access grant only decides whether crhs lets a task start. A `forward` node still applies its
  own trust configuration to privileged tasks.

Every user and every user group has a library. A personal library is reachable only by its user, a
group library by the group's members, and administrators reach every library without access checks. An
agent session reaches its owner's libraries ([Libraries](library.md#libraries)).

Sessions can be shared with users and user groups at two levels: `view` (read the session) and `chat`
(also send messages and stop runs). Nodes are not shared; they are granted.

- A shared session still acts as its owner, with the owner's node access and the session's own rules.
  The audit log records both the owner and the user who sent the message.
- Only the owner can share a session or change its configuration. A session cannot be shared with its
  owner or with the caller, so an administrator cannot turn read-only access into chat access.
- A share on a root session covers its subagents. Revoking a share closes event streams that it
  covered.
- Users with a share cannot decide approvals.
- The API returns the caller's capabilities on each object (view, chat, manage shares, configure), and
  the UI relies on those rather than on the relationship.

## Actors

Every task and audit event records an actor and the user it acts on behalf of:

| Actor | Acts on behalf of |
|---|---|
| User | Themselves |
| Session, subagent | The session owner |
| Schedule | The schedule owner |
| API token | The token owner |
| System | Nobody |

Every permission check starts from the on-behalf-of user's node access, then applies the actor's rule
chain. The actor type affects only attribution.

## Authorization rules

crhs rules decide whether an actor may start a task. Rules can match privileged and ordinary tasks
separately, so ordinary work can be allowed while privileged work still asks. On `native` and `ignore`
nodes the crhs rules are the only check for privileged tasks; on `forward` nodes the node's trust
configuration must also allow it.

### Rule chain

Users have no standing rules. A rule chain starts at an object that acts for a user:

| Situation | Rule chain |
|---|---|
| A user running a task in the WebUI | None; only node access is checked |
| Session | Root session → subagent → … |
| Scheduled task | Schedule → the session for the run → subagents |
| MCP | API token |

A root is configured by a rule preset plus any rules the owner adds:

| Preset | Behavior |
|---|---|
| Ask | Allows non-privileged reads; everything else needs the user's approval. |
| Auto Review | Like Ask, but the review model decides first and passes anything risky or unclear to the user. |
| Yolo | Allows everything by default. |

Choosing "always allow" on an approval appends an allow rule to the root. A subagent receives a full
rule set from its parent at creation and can only be stricter than its parent. Presets give a person a
simple choice; full rule sets let an agent restrict a subagent precisely.

### Rules

A rule has an action (`allow`, `require-approval`, `deny`) and optional matchers: the method (`exec`,
`file.read`, `file.write`), the nodes, whether the task is privileged, and an `exact` or `prefix`
target, as defined in [Methods and targets](privilege.md#methods-and-targets). Each level also has a
default for tasks no rule matches. The schema is in `packages/api/src/policy.ts`.

- `allow file.write` also allows reading the same target, but `deny file.write` blocks only writes:
  "do not modify" should not mean "do not look".
- Rules have no regular expressions. Rules run on the crhs event loop and may be written by an agent,
  and one pathological expression could stall the whole server. crha's guard rules use RE2 and are not
  affected.

### Evaluation

Rules are a ceiling that can only get lower down the chain.

1. Each level's own result is its strictest matching rule (`deny` over `require-approval` over
   `allow`), or its default when no rule matches.
2. The cumulative result starts at the root's own result; each later level keeps the stricter of the
   cumulative result so far and its own result.
3. The last level's cumulative result is the decision.

A lower `allow` therefore cannot lift a restriction from above; it is useful only with a stricter
default at that level, such as a subagent that denies by default but allows `systemctl status`. A
scheme where any level's allow suffices was rejected because a subagent could then widen its parent's
limits. The evaluation of every level is stored with the task, so approvals show the whole chain.

### Environment and working directory

Rules match only the command or path, not the task's environment or working directory. crhs rules are
not a sandbox: a rule that allows `systemctl status` also allows that command with `LD_PRELOAD` set.
Matching the environment would add many platform-specific cases and new false allows. Use a `forward`
node when isolation matters; its trust entries restrict the environment.

### Approvals

An approval is part of the task, not a separate object: the task waits in `awaiting_approval`, and the
decision, decider, reason and each level's judgment are stored on it. A task group is approved once.

- A request goes up the chain from the level that raised it to the nearest ancestor whose cumulative
  result is `allow`. That agent may approve, reject or escalate; it escalates when the restriction came
  from a lower level. A restriction a subagent carries is its parent's guardrail, so the parent can
  lift it, but the root preset still bounds the root agent.
- If no agent may decide or the agent escalates, the review model decides first for Auto Review, and
  otherwise the root's owner decides in the WebUI.
- The review model sees only the operation, never the conversation or node output, and can approve or
  escalate but never deny.
- An approval has no deadline. It waits until someone decides, a rule change removes the need, or the
  API token that started it is revoked or expires. The system does not give up a user's decision for
  them.
- Changing any rule on the chain re-evaluates every waiting task on that chain. A one-off decision
  does not create a rule; only "always allow" does.
- An approved task group is still checked per member when it runs, so a deny rule added after the
  approval still applies.
- When a node trusts only the user's signature, that signature counts as the approval as well, so
  the user does not approve twice.

## API tokens

An API token belongs to its creator, is shown once, and is stored only as a hash. It expires after a
chosen lifetime or never, and can be revoked at any time. Every request checks the token, so
revocation and expiry take effect at once, and both reject the tasks the token started that still
wait for approval.

A token is the root of the MCP rule chain and can use only Ask or Yolo. Auto Review was excluded
because the review model sees only the operation, and a token has no session or user instruction
behind it, so a review cannot stand in for the user. A token reaches the same nodes as its owner but
authenticates only `/mcp`: no administrative action is possible with a token, even an administrator's.

A password change ends the user's other WebUI sessions but does not revoke their tokens. A token can
be deleted only after it is revoked or expired.

## Audit

Every significant change is appended to the audit log with an actor, the user it acted for, an
action, an optional target and a small detail object. Administrators see every event; other users see
the events recorded on their behalf. The log holds metadata and references, not task output or
messages, which stay in their own tables.

### Recorded events

Events cover authentication, nodes and node groups, tasks and approvals, authorizations, sessions and
tool calls, users and sharing, configuration, and the `crhs` CLI. Action names are dotted verbs such as
`node.approved` or `task.approval`. Model calls are not audited; their usage is part of
[session statistics](agent-runtime.md#session-statistics).

The CLI writes with the actor `system:cli` and adds `via: "cli"`, the OS user, uid and host to the
detail. It records `keys.initialized`, `keys.imported`, `keys.exported` (the key fingerprints and the
output path, never key material), `user.created` and `user.password_reset`. A user change and its
event share one transaction; a key export is removed again if its event cannot be written. These
records cover what went through crhs, not what someone with the master key file or the database can
do without it ([Audit](../guide/security.md#audit)).

### Tamper resistance

The audit log is append-only and has no hash chain. Without a key, anyone who can write the database
can recompute a hash chain, so it would catch corruption but not an attacker, at the cost of extra
work on every append. crhs uses one database account, so the database cannot defend against a
compromised crhs either.

On the node, the privileged mode keeps its own log of every privileged task, which crhs cannot change.
Tamper evidence for the crhs log requires exporting it to a system outside crhs.

Old events are removed by [retention](data-model.md#retention), which always keeps the newest ones.

## Extension points: OIDC

OIDC login is not implemented, but the design leaves room for it. Login only answers which user this
is; sessions and permission checks do not depend on how the user signed in, and a user may have no
password. An implementation would link external identities to local users and could sync user groups
from a groups claim; user groups already record their source. Signing privileged tasks stays separate
from login.

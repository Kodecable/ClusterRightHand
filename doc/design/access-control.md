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

A username and a user group name are trimmed, lower-cased and must start with a letter:
`^[a-z][a-z0-9._-]{0,63}$` (`server/src/users/service.ts`, `server/src/users/user-groups.ts`).
Existing rows are not migrated or rechecked: users cannot be renamed, and a group name is checked again
on its next rename.

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
active administrator. Disabling a user ends their WebUI sessions, invalidates their API tokens, cancels
the tasks and task groups they left waiting for an approval or a signature, and disables their scheduled
tasks.

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

Creating or renaming a node or node group locks the organization row (`FOR UPDATE` on PostgreSQL)
before it checks the shared namespace and writes. The check reads two tables, so no single unique
constraint covers it: two concurrent transactions would otherwise both see the name as free. SQLite's
one-writer transactions already serialize them.

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
user group library by the user group's members, and administrators reach every library without access
checks. An agent session's library tools reach its owner's libraries; an administrator's agent reaches
the others through `api_request` ([Libraries](library.md#libraries)).

Sessions can be shared with users and user groups at two levels: `view` (read the session) and `chat`
(also send messages and stop runs). Nodes are not shared; they are granted.

- A shared session still acts as its owner, with the owner's node access and the session's own rules.
  The audit log records both the owner and the user who sent the message.
- This includes the owner's role: `api_request` runs as the owner, so a `chat` share on an
  administrator's session lets members ask its agent for administrative requests, decided by the
  session's rules. Sharing an administrator's session at `chat` level is a delegation of that authority;
  share a session with tighter rules, or at `view` level, when that is not meant.
- Only the owner can share a session or change its configuration. A session cannot be shared with its
  owner or with the caller, so an administrator cannot turn read-only access into chat access.
- A share on a root session covers its subagents. Revoking a share closes event streams that it
  covered.
- Users with a share cannot decide approvals.
- A session's todo list is the agent's; share viewers and administrators see it read-only, and no route
  writes it ([Todo list](todo.md)).
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
| Scheduled task | The run's session (a copy of the schedule's rules) → subagents |
| MCP | API token |

A schedule is a template, not a level: each run's session is an ordinary root whose rule set was copied
from the schedule's at creation ([Rules and quotas](scheduling.md#rules-and-quotas)). "Always allow" in a
run writes to that session's copy, and a later schedule edit reaches only future runs.

A fork starts a new root with a copy of its source root's rule set, never a reference to it: the preset
and the custom rules are duplicated, so an edit on either side leaves the other unchanged
([Forking](agent-runtime.md#forking)).

A root is configured by a rule preset plus any rules the owner adds:

| Preset | Default | Rules of the preset |
|---|---|---|
| Ask | `require-approval` | allow non-privileged `file.read`, `ext.read` and `api.read` |
| Auto Review | `require-approval` | the same as Ask; the review model answers approvals first and passes anything risky or unclear to the user |
| Yolo | `allow` | none |

The owner can change a root's preset at any time. The rules on top of it grow only through "always
allow" on an approval, which appends an allow rule to the root, whichever level the request came from.

A subagent's level is set once, when its parent creates it: the rules the parent passes, or none. It is
fixed for the subagent's life: neither the parent agent nor the owner can change it later, and it has no
preset. Changes to the levels above still reach the subagent at once, because the chain is read at every
evaluation. Presets give a person a simple choice; a subagent's own level lets an agent restrict a
subagent precisely, and it can only restrict ([Evaluation](#evaluation)).

### Rules

A rule has an action (`allow`, `require-approval`, `deny`) and optional matchers: the method (`exec`,
`file.read`, `file.write`, `ext.read`, `ext.write`, `api.read`, `api.write`), the nodes, whether the
task is privileged, and an `exact` or `prefix` target, as defined in
[Methods and targets](privilege.md#methods-and-targets). A matcher that is left out matches anything, and a
rule matches only when all of its matchers do. The schema is in `packages/api/src/policy.ts`.

Each level also has a default, its result for an operation no rule of the level matches: `allow`,
`require-approval` or `deny`, or, below the root, `inherit`. A root's default comes from its preset and
cannot be `inherit`, since nothing is above it. A subagent created without rules, or with rules but no
`default`, has `inherit`.

Extension calls use `ext.read` (a read-only tool on an extension whose annotations are trusted) and
`ext.write` (every other tool). Their target is `<extension>/<tool>`, so `prefix: "github/"` covers an
extension ([Rules and approvals](extensions.md#rules-and-approvals)). The built-in `crhs-api` extension states
its own `api.read`/`api.write` operations on the request's route (`<METHOD> <path template>`), so a rule
such as `prefix: "POST /api/node-groups"` covers a family of routes. A rule with `nodes` never matches an
external call, and external calls are never privileged.

- `allow file.write` also allows reading the same target, and `allow ext.write` and `allow api.write`
  the matching read. A `deny` or `require-approval` rule matches its own method only: `deny file.write`
  blocks writes, not reads, because "do not modify" should not mean "do not look".
- Rules have no regular expressions. Rules run on the crhs event loop and may be written by an agent,
  and one pathological expression could stall the whole server. crha's guard rules use RE2 and are not
  affected.

### Evaluation

Rules are a ceiling that can only get lower down the chain.

1. **A level's own result** is the strictest of its matching rules (`deny` over `require-approval` over
   `allow`). The order of the rules does not matter: there is no "first match wins". With no matching
   rule, the result is the level's default.
2. **The chain** starts at the root's own result. Each later level keeps the stricter of the result so
   far and its own result; `inherit` adds nothing, so a level that inherits keeps the result from above.
3. The last level's result is the decision. The evaluation of every level is stored with the task, so
   approvals show the whole chain.

What follows from this, and is easy to get wrong:

- **An exception is not written by order.** "Allow `systemctl status`, deny the rest of `systemctl`"
  cannot be a `deny prefix: "systemctl "` plus an `allow exact: "systemctl status"` on one level: both
  match, and the deny wins. Write the narrow allow with a stricter default instead (default `deny`,
  allow `systemctl status`), or keep the wide restriction on a level above.
- **A lower `allow` never lifts a restriction from above.** It matters only against a stricter default
  of its own level, as in the example above. A subagent therefore can never do what its parent may not:
  a scheme where any level's allow suffices was rejected because a subagent could then widen its
  parent's limits.
- **A subagent without rules has exactly its parent's limits**, not "everything allowed": `inherit`
  defers to the levels above.
- **"Always allow" lifts only what the root imposed.** The rule goes to the root, so it ends an approval
  only when the root's default or rules caused it. When the subagent's own level asks or denies, or a
  stricter rule on the root matches too, the root's allow changes nothing, and since a subagent's level is
  fixed, its restriction stays. crhs therefore offers an always-allow candidate only when appending it to
  the root would make every waiting operation `allow` (for a task group, every node that needs the
  approval), the WebUI shows no **Always allow** when none would, and a decision that sends a rule that
  would not end the approval is refused.

### Environment and working directory

Rules match only the command or path, not the task's environment or working directory. crhs rules are
not a sandbox: a rule that allows `systemctl status` also allows that command with `LD_PRELOAD` set.
Matching the environment would add many platform-specific cases and new false allows. Use a `forward`
node when isolation matters, with trust entries that list their variables in `env_allow`
([Guard rules](privilege.md#guard-rules)).

### Approvals

An approval is part of the object that waits. A task waits in `awaiting_approval`, and the decision,
decider, reason and each level's judgment are stored on it; a task group is approved once. An external
external call has its own small object, `external_calls`, and waits the same way
([External calls](extensions.md#external-calls)). The server builds one compact,
locale-free `ApprovalRequest` from the waiting row — kind, phase, source, structured action, node
names, privileged flag, the settled review, the always-allow candidates and, when a tool call started
the work, its `job` (`id`, `kind`, `action`) — and the chat channels and the WebUI render that model, so
no surface rebuilds a per-kind summary from prose ([Approvals in chat](channels.md#approvals),
[Approvals and jobs](jobs.md#approvals-and-jobs)). A task or task group waiting for the user's signature
(`awaiting_authorization`) gets the same request with phase `awaiting_signature`; the task, task group
and approvals list endpoints return it beside the kind-specific view while the item waits, and `null`
once it is settled.

- A request goes up the chain from the level that raised it to the nearest ancestor whose cumulative
  result is `allow`. That agent may approve, reject or escalate; it escalates when the restriction came
  from a lower level. A restriction a subagent carries is its parent's guardrail, so the parent can
  lift it, but the root preset still bounds the root agent.
- If no agent may decide or the agent escalates, the review model decides first for Auto Review, and
  otherwise the root's owner decides in the WebUI.
- The review model sees the session's instructions and tool calls plus the operation, never assistant
  text, tool results or node output, and can approve or escalate but never deny
  ([Auto Review](#auto-review)).
- An approval has no deadline. It waits until someone decides, a rule change removes the need, or the
  API token that started it is revoked or expires; the waiting work the token started then ends
  `cancelled`, because no person decided against it. The system does not give up a user's decision for
  them.
- A request Auto Review will judge is written in `awaiting_approval` with a pending-review marker
  (`review: { status: "pending", startedAt }`) in the same write. Until the verdict arrives it is
  **reviewing**: the operation looks like a tool call still in progress, the session stays `running`, it
  is not listed as a pending approval or sent to chat, and a decision endpoint refuses it with a conflict.
  The verdict replaces the marker; an escalated request, a failed or timed-out review, and a review that
  does not run after all become an ordinary user-facing approval (`awaiting_user`, the default phase).
- Changing any rule on the chain re-evaluates every waiting task on that chain. A one-off decision
  does not create a rule; only "always allow" does.
- An approved task group is still checked per member when it runs, so a deny rule added after the
  approval still applies.
- When a node trusts only the user's signature, that signature counts as the approval as well, so
  the user does not approve twice.
- A waiting approval also reaches the owner in chat ([Approvals in chat](channels.md#approvals)): a
  rule approval that needs no signature has Approve and Reject there, decided through the same checks
  and audited with the channel. "Always allow" changes rules, so it stays in the WebUI; an approval
  that needs a signature gets a **Signature needed** card whose hint links to its page.

### Auto Review

Auto Review stands in for the user's decision on an Auto Review root: the review model approves what is
clearly safe and escalates the rest; it can never deny. It sees the requesting session's history and the
operation, each as data in a fenced JSON block whose content cannot close the fence:

- **user-instruction**: every user message of that session, whoever sent it (the owner, a shared user,
  a schedule's prompt, a parent's task for a subagent). Only a user instruction can authorize an
  action, and a later one overrides an earlier one only when it explicitly revokes or replaces it.
- **checkpoint**: the latest compaction summary, at its position. It restores context but never carries
  instruction authority.
- **facts**: earlier tool calls that already have a result, with their name and arguments (the call
  under review and others of its round have not run yet). They establish facts and never authorize a
  medium-risk action.

Assistant text and thinking, tool results, node output and system messages are excluded entirely. The
history keeps the most recent 20 user instructions and the most recent 32 KiB of serialized tool calls;
one call's arguments are cut to 4 KiB with a note of the original size, and the cut counts toward the
budget. Tool calls older than the oldest kept instruction are dropped even when budget remains. Omitted
ranges are marked in place: a leading `[earlier history omitted]`, and `[N earlier tool calls omitted
here]` where tool calls were dropped between kept entries.

The operation block is the original tool call, not a summary: the tool's name and arguments exactly as
the model requested them and complete, plus the tool's description (a cluster tool's, an MCP tool's from
its extension's list, and for `crhs-api`'s `api_request` the matched API route's summary). A request
whose operation does not fit the review model's context even without the history goes to the user.

crhs resolves the trusted context: every target node's id, name and node group names, and the part the
rules flagged for approval — the method and target of a task, or one method/target per flagged member
of a task group.

A task, task group or external call records the durable tool task of the tool call that created it
(`source_tool_task`), and the reviewer reads that call, complete, from the requesting session's
transcript. A model may reuse call ids, so the durable task, not the id, identifies the call. Auto Review
judges tool calls: a request no tool call made (an API token or MCP request, or work created by the
WebUI) never enters it and waits for the user from the start. When the tool task is gone (after
retention, for example) or does not name a matching call, the request goes to the user without a model
call: a review that cannot see the exact call cannot stand in for the user's decision. The call under review has no result yet, so it stays out of the history
facts above.

A task, task group or external call records the pending marker only when the root's preset is Auto
Review and a review model resolves, so other requests are user-facing from the start. The marker is
durable while the review call is not: after a restart every request still carrying it is reviewed
again, and a replaying tool call joins that review instead of starting a second one
([Session state](agent-runtime.md#session-state)).

The reviewer assigns one of three risk levels:

| Level | Covers | Decision |
|---|---|---|
| low | Reads and ordinary non-destructive work, and exact cleanup of objects this session's earlier tool calls created | Approve |
| medium | Deleting or overwriting pre-existing data, production changes or deployments, service stops or restarts, package installs or removals, security, credential, user, firewall, network or permission changes, and external writes | Approve only when a user instruction explicitly authorizes this action, this target and this scope, with no unresolved conflict |
| high | Sending credentials, secrets or private data to an external or untrusted destination, and equivalents | Always escalate |

Node names and node groups can tell production from test. Two rules widen what counts as the
operation's effect:

- **Plausible bugs.** The operation is read the way the shell or tool will run it, and the risk is that
  of what a plausible bug would do: an empty or unset variable or substitution in a path
  (`rm -rf "$DIR/"` with an empty `DIR`), an unquoted path with spaces or globs, an over-broad glob,
  `find` or recursive flag, a path that depends on the working directory, a missing `--`, or a
  truncating redirection.
- **Departure from the instruction.** A user instruction authorizes only what it asks for. A different
  target, node, path or action, a wider scope, or side effects the request does not need are not
  authorized by it, and such a departure that changes data or state beyond ordinary non-destructive
  work is at least medium risk, so it reaches the user.

Both rules are in the fixed protocol; the default prompt adds the concrete bug patterns. The reviewer answers through the
`submit_review` tool with a decision and a risk; only low+approve, medium+approve, medium+escalate and
high+escalate are valid. A high-risk approval, a missing or invalid risk and any other inconsistent
answer escalate with an invalid-answer reason. No instruction can lower a risk level, and a high-risk
operation is always escalated even when a user instruction asks for it. The fixed protocol text states
these rules; only the preset's prompt is replaceable ([Model presets](agent-runtime.md#model-presets)).
The risk is stored with the verdict and shown next to its reason on the approval pages.

## API tokens

An API token belongs to its creator, is shown once, and is stored only as a hash. It expires after a
chosen lifetime or never, and can be revoked at any time. Every request checks the token, so
revocation and expiry take effect at once, and both reject the tasks the token started that still
wait for approval.

A token is the root of the MCP rule chain and can use only Ask or Yolo. Auto Review was excluded
because it needs a session's user instructions to authorize medium-risk actions, and a token has none,
so a review cannot stand in for the user. A token reaches the same nodes as its owner but
authenticates only `/mcp`: no administrative action is possible with a token, even an administrator's.

A password change ends the user's other WebUI sessions but does not revoke their tokens. A token can
be deleted only after it is revoked or expired.

## Audit

Every significant change is appended to the audit log with an actor, the user it acted for, an
action, an optional target and a small detail object. Administrators see every event; other users see
the events recorded on their behalf. The log holds metadata and references, not task output or
messages, which stay in their own tables.

### Recorded events

Events cover authentication, nodes and node groups, tasks and approvals, external calls
(`external_call.started`, `external_call.finished` — including a waiting call whose tool call was
aborted, recorded with state `cancelled` — `external_call.review`, and `external_call.approval` for a
decision, all with arguments truncated), extension changes (`extension.created`, `extension.updated`,
`extension.deleted`, without header values), sessions and tool calls (`session.stop` records its
`source`: `web`, `channel_command` or `channel_draft_stop`, plus the channel account and thread for a
chat stop), users and sharing, configuration, and the `crhs` CLI. Action names are dotted verbs such as
`node.approved`, `task.approval` or `external_call.review`. Model calls are not audited; their usage is
part of [session statistics](agent-runtime.md#session-statistics).

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

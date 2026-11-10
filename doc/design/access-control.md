# Users, ownership and audit

Access control in crhs has two layers: which users may see and use a node or a session, and which
operations an object acting for a user may start. This document describes the user and ownership
model, node access grants, session sharing, the authorization rules and their chain, approvals, API
tokens, the audit log and the reserved OIDC extension point. The components are described in
[Architecture](architecture.md), task states and dispatch in [Execution](execution.md), privilege
trust on a node in [Privilege](privilege.md), and the wire messages in [Protocol](protocol.md).

## User model

The server is built for one organization with several users. Organization-scoped tables carry
`org_id` from the start because adding the column later would touch every table and query; the
server has no multi-organization feature and creates a single organization named `default` on first
use.

| Object | Meaning |
|---|---|
| User | A person who signs in to the WebUI. There are two kinds: administrator and regular user. Login uses a local password. |
| UserGroup | A named set of users, maintained by administrators. Used to share sessions and to grant node access to several users at once. |
| UserCredential | A user's signing credential: an SSH public key (including a FIDO hardware key) or a Passkey. Used only to sign privilege authorizations, never to log in ([Signing methods](privilege.md#signing-methods)). |
| ApiToken | Belongs to a user, has an expiry, and is the root of its own rule chain. Used by MCP clients and automation. |
| Node | A managed host. It belongs to the organization and is managed by administrators, and it may belong to several node groups. Users reach it through a node access grant. |
| NodeGroup | A group such as `web` or `prod`, maintained in crhs by administrators. Used to select nodes (rule `nodes`, task targets, scheduled tasks) and to grant access. A privilege trust alias usually holds its UUID. |
| NodeAccessGrant | An administrator grants a user or a user group access to a node or a node group. There is one level: view and execute. It is not a privilege authorization ([Authorizations](privilege.md#authorizations)). |

Nodes are organized by node groups rather than tags. Wherever a set of nodes is needed, the value is
a list of node and node-group references such as `["web-1", "prod"]`. The documents and the WebUI
say "node group" or "user group"; "group" alone never means a node group.

Node groups are crhs data. A group contains nodes only and does not nest; crha nodes and SSH nodes
are members the same way, and membership changes take effect immediately. `crha.toml` has no
`groups` key, and a configuration file that contains one fails at startup instead of being ignored.

A user is created with a username, a display name, and optionally an email address and a password.
Usernames are lowercased, 1–64 characters of `a-z`, `0-9`, `.`, `_` and `-`, start with a letter or
digit, and are unique in the organization. A user group name is lowercased, 1–64 characters of the
same alphabet, and unique among user groups. A local password must be at least 8 characters when it
is created or reset.

## User types

There are no roles and no fine-grained permissions. The only distinction is the user kind:
administrator (`admin`) and regular user (`member`).

| Kind | What it may do |
|---|---|
| Administrator | Everything a regular user may do; manage users and user groups; configure models; manage nodes, node groups, SSH credentials and node access grants (create enrollment tokens, confirm registration, add SSH nodes, delete or rename nodes, change node-group membership); view every node and session; view the whole audit log. Another user's session is read-only by default: an administrator cannot change its rules or decide its approvals, may chat only after an explicit `chat` share, and may list and revoke its shares but not create one. |
| Regular user | Manage their own sessions, scheduled tasks and API tokens; see and operate the nodes granted to them or to one of their user groups, including the current members of a granted node group; use sessions shared with them; see the audit events recorded on their behalf. |

Only an administrator may manage users and user groups. The one exception is `GET /api/users/:id`:
an administrator reads any user, a regular user reads only themselves, and any other id returns the
same 404 as a missing user, so an unprivileged caller cannot probe for accounts. User-group detail
and rename remain administrator-only. Every user may search the directory (`GET /api/directory`) to
find someone to share with; it returns ids, usernames and display names only.

An administrator cannot change their own kind or disable themselves; another administrator must do
it. The server also refuses a change that would leave the organization without an active
administrator. Disabling a user ends their WebUI sessions, makes their logins and API tokens fail,
and disables their scheduled tasks.

What a user may do to a node is not decided by a permission table. When the user acts in person,
crhs checks only whether the user can access the node. When a session, scheduled task or API token
acts for the user, the authorization rules on its chain apply as well (see [Authorization
rules](#authorization-rules)). The API's `scope=all` session list is administrator-only; the WebUI
lists the user's own and shared sessions (`visible`) instead.

On a node that trusts only specific users, no identity on the crhs side is enough to elevate a task:
the trusted user must sign, or the node must approve locally ([Local approval](privilege.md#local-approval)).

## Node groups and names

A node group contains nodes only and does not nest. Membership is maintained in crhs and applies
immediately: a node added to a group is available to everyone the group is granted to, and a node
removed from it is no longer available.

Nodes and node groups share one namespace per organization, so a node and a node group cannot have
the same name, compared case-insensitively. Both have an immutable UUID. Every internal reference to
a node or node group — a rule's `nodes`, a node access grant, a task group's targets — stores a
UUID, except `_all`, which is stored as written. Names are input and display only: the API, agent
tools and MCP accept a name or a UUID, resolve it on write, and display the current name; a
reference whose object was deleted is shown as a deleted node or node group (the API reports a null
name).

Renaming therefore changes one field and rewrites no reference. Deleting an object and recreating
one with the same name produces a new UUID, so old references do not apply to the new object. Using
the name as the primary key was rejected because a rename would then rewrite rules, grants and
history.

A user-chosen name matches `^[A-Za-z][A-Za-z0-9._/-]*[A-Za-z0-9]$` and is 2–64 characters: it starts
with a letter, ends with a letter or digit, and contains only letters, digits, `.`, `_`, `/` and
`-`. Uniqueness and lookup compare lowercase; the stored name keeps its case for display. Names
starting with `_` are reserved for the system, and the rule excludes them; the only such name is
`_all`, which means every node the acting user can access and is evaluated when the rule or target
is used.

A generated default name (an enrollment token's `name_hint`, a hostname, an SSH host) is normalized
first: characters outside the rule become `-`, a leading non-letter gets the prefix `n-`, trailing
non-alphanumerics are removed, a too-short name is padded with `0`, a too-long one is cut to 64, and
a name already in use gets `-2`, `-3`, and so on.

## Login, rate limiting and verification

Password login (`POST /api/auth/login`) is the only login method. Before the password is verified,
crhs checks the proof of work (when enabled) and then the rate limiter; a rejected challenge or a
limited attempt never reaches Argon2id. Passkeys are not a login method: they sign privilege
authorizations only. All limits live in the crhs process and reset on restart.

A successful login creates a WebUI session, stored in `web_sessions` and carried by the `crh_session`
cookie, which is valid for 7 days. An unknown username, a user without a password, a wrong password
and a disabled account all answer 401 `invalid username or password`; the audit event
`auth.login_failed` records which reason applied and the client address. A login for an unknown user
verifies against a dummy hash, so it takes the same time as a wrong password.

### Client address

- With `listen.real_ip_header` unset, the client address is the peer address of the connection
  socket.
- With a header name set (for example `X-Forwarded-For` or `X-Real-IP`), crhs reads that request
  header, splits it on `,`, trims each element, and uses the first non-empty element. A missing or
  empty header falls back to the socket peer address. There is no trusted-proxy list, and crhs does
  not walk the list from right to left to skip addresses appended by proxies.
- The deployer must make the reverse proxy overwrite a same-named header supplied by the client.
  When crhs is exposed directly, any client can forge the header; the default
  `listen.host = "127.0.0.1"` and a firewall are the intended protection.
- The RFC 7239 `Forwarded` header format is not supported.
- The address is used for login rate limiting, for the Cap challenge scope, and for the IP stored on
  a WebUI session. See the [crhs configuration reference](../guide/reference/crhs-config.md#listen).

### Rate limiting

- A login attempt is counted under two keys: `addr:<address>` and
  `addr-user:<address>\0<lowercased trimmed username>`. There is no username-only key. When no
  address is known (tests, or no socket), only `addr-user:\0<username>` applies.
- `LoginLimiter.reserve` checks both keys and counts this attempt as a failure in one synchronous
  step before Argon2id runs, so a burst of concurrent requests cannot all pass the check.
- A successful login deletes this attempt's `addr-user` key and gives back its own reservation on
  the `addr` key. Failures other usernames caused on that address remain, so a user with a valid
  account cannot interleave successes to clear the address and keep guessing other names.
- Only one login per address may be in password verification at a time. The check comes before the
  reservation, so a request turned away here is not counted as a failure; a second concurrent login
  returns 429 with `code = "login_in_progress"`.
- At the limit (10 failures in 15 minutes) the login and challenge endpoints return 429 with
  `code = "rate_limited"`. A limited attempt is not audited, so brute force cannot fill the audit
  log.
- A wrong current password in a password change is counted the same way, under `user:<user id>` and
  the same `addr:<address>` key, with one change in flight per account
  (`code = "password_change_in_progress"`). A correct change clears the account key and gives back
  its address reservation, like a successful login.

### Password hashing

Passwords are hashed with Argon2id from `node:crypto`, which requires Node.js 24.7 or later. The
stored value is a PHC string, `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<tag>`, using standard base64
without padding.

The defaults are `m = 65536` KiB (64 MiB), `t = 3`, `p = 1`, a 16-byte salt and a 32-byte tag. The
parser rejects memory above 1 GiB, passes above 20, parallelism above 16, memory below 8 ×
parallelism, a salt shorter than 16 or longer than 64 bytes, a tag other than 32 bytes, and
non-canonical base64; a string that does not parse verifies false.

A password is NFKC-normalized before hashing and is at most 1024 characters. A new or changed
password must also be at least 8 characters; a login enforces only the maximum. When the stored
parameters differ from the current ones, `needsRehash` makes a successful login recompute and store
the hash with the password it just verified; that path skips the minimum-length policy.

Every Argon2id computation — hash or verify, from every caller — passes through one process-wide
gate. By default at most 2 hashes run and 32 queue; when the queue is full the request fails
immediately with 503, `Retry-After: 1` and `code = "hash_busy"`. Peak memory is about the
concurrency × 64 MiB. Hashes run on the libuv thread pool, which has 4 threads by default
(`UV_THREADPOOL_SIZE`). A login hash may use every slot and the whole queue; other hashes (password
change, reset, user creation) are limited to `concurrency - 1` running hashes when there are at
least two slots and to half the queue, so a signed-in user cannot take the last slot and make every
login answer 503.

The queue size, concurrency and related settings are in the [crhs configuration
reference](../guide/reference/crhs-config.md#auth).

### Cap proof of work

With `[auth] captcha = "cap"` (the default), a password login must first obtain and solve a Cap
challenge. capjs-core issues it as an HMAC-signed JWT, and crhs keeps no state; it is valid for 2
minutes. The signing secret is generated once per process, so a restart invalidates outstanding
challenges.

1. `GET /api/auth/login-options` returns `{ "captcha": "cap" | "none" }`.
2. `POST /api/auth/login/challenge` with body `{ username, tag }` returns
   `{ challenge, token, expires }`. `tag` is 43 base64url characters; crhs checks only its length and
   character set and cannot verify it from the username alone (it contains the password). When the
   address is already rate-limited, this endpoint answers 429 `rate_limited`.
3. The WebUI solves the challenge and puts `{ token, solutions }` into the login body's `cap` field.
   crhs recomputes the tag and scope from the submitted username and password and asks capjs-core to
   verify them. A failure returns 403 with `code = "captcha_failed"` and a `reason` such as
   `scope_mismatch`, `expired` or `invalid_solution`. It is not counted as a login failure and no
   Argon2id runs. A login with the `cap` mode enabled and no `cap` field returns 400
   `captcha_required`.

The bindings are:

- `tag = base64url_nopad(SHA-256(UTF-8(username) || 0x00 || UTF-8(password)))`, over the submitted
  strings with no trimming or normalization.
- `scope = base64url(HMAC-SHA256(scopeKey, address || 0x00 || username || 0x00 || tag))`, where the
  address is the [client address](#client-address) (an empty string when unknown).
- The capjs-core token stores the scope and verification requires the scope computed from the
  current submitted username and password, so a challenge is bound to address, username and
  password together.

The challenge token is deliberately replayable: crhs records no used nonce, and replaying a token
repeats the same guess. With a wrong password the replay is the same wrong password, counts against
the limit again and runs Argon2id again; with the right password the attacker already knows it,
which is the same as repeating a normal login. Guessing a different password changes the tag and
therefore the scope, so the attacker must request a new challenge and solve the proof of work again.
The one-login-per-address rule also prevents a valid token from multiplying concurrent Argon2id work
or sessions at one address.

With `[auth] captcha = "none"` the challenge endpoint returns 404 and the login ignores the `cap`
field. This is intended only for controlled environments that cannot run a browser.

## Ownership, access grants and sharing

Nodes and node groups belong to the organization and are managed by administrators. Sessions,
scheduled tasks and API tokens belong to the user who created them.

- A node has no owner. Enrollment tokens, SSH nodes and SSH credentials are created by
  administrators, and an administrator confirms registration. Per-user node ownership was rejected
  because it spreads a cluster over several owners and sharing an SSH node would lend the owner's
  SSH credential to the grantee.
- A session belongs to the user who created it. A subagent's child session belongs to the parent
  session's owner, and a session created by a scheduled run belongs to the schedule's owner.
- A scheduled task and an API token belong to their creator and cannot be shared.

A node access grant is one record: a grantee (user or user group) and a target (node or node group),
with one access level. A single level is deliberate: read-only access to a node is of little use and
would complicate the model without protecting anything, because running a task is the only thing a
node is for.

| Grantee | What the grant gives |
|---|---|
| User | See the node and its Facts, and run tasks on it, including privileged tasks. |
| User group | The same for every member of the group. |

A grant on a node group is dynamic: a node added to the group is available to the grantee, and a
node removed from the group is no longer available.

Node and session visibility:

- The nodes a user can access are the nodes granted to the user or to one of their user groups,
  plus the current members of granted node groups; an administrator can access every node.
- A node the user cannot access is invisible: it is absent from lists, selectors and the rule
  editor, and a request by id returns 404, not 403.
- Whether a task or task group is visible depends only on the user's relation to it, never on node
  access. The `on_behalf_of` user sees their own tasks, including those started by their sessions,
  scheduled tasks and tokens, even after losing access to the node. A user who can view the session
  that issued a task sees the task through the session. An administrator sees every task. Node
  access never reveals another user's tasks.
- Access is checked when the task is created and again before the task is dispatched, after any
  approval or signature wait. A waiting task whose user lost access ends with
  `error_code = node_access_revoked`; a task already dispatched is unaffected. A waiting task whose
  node was deleted ends with `node_deleted` ([State machine](execution.md#state-machine)).
- When the user acts in the WebUI, crhs still checks only node access.
- A node access grant and privilege trust are independent: the grant decides only whether crhs lets
  the task start. On a `forward` node a privileged task still needs the node's trust configuration
  to accept it ([Privilege](privilege.md)). On a node that trusts only specific users, another user
  with access who requests a privileged task still needs the trusted user's signature or a local
  approval.

Sessions can be shared with additional users and user groups; nodes are not shared.

| Resource | Access | Meaning |
|---|---|---|
| Session | `view` | See the session's content and state. |
| Session | `chat` | In addition to `view`, send messages and interrupt a run. |

- The API returns capabilities computed on every request — `view`, `chat`, `manageShares`,
  `createShares`, `configure` — and a display-only `relationship` (`owner`, `admin`, `shared`).
  Authorization uses only the capabilities. `manageShares` (list and revoke a share) belongs to the
  owner or an administrator; `createShares` and `configure` belong to the owner only.
- `shares.access` is the level a share grants, not the caller's effective capability.
- A share on a root session reaches its subagent child sessions. A child session can also be shared
  on its own. An inherited `view` or `chat` is the strongest level on the chain.
- Revoking a share closes event streams already open on that session, or on the root that covered
  it.
- Only an administrator may manage nodes, node groups and node access grants. Only the owner may
  create a share and change the session's configuration; the owner or an administrator may list and
  revoke shares.
- A session cannot be shared with the caller (`granteeType: "user"` and `granteeId` equal to the
  caller) or with its owner. The owner already has full access, and an administrator must not turn a
  read-only relationship into a driveable one through a share.
- A session acts as its owner. A user with a `chat` share who sends a message drives the session
  with the owner's current node access and the session's own rules. The audit records the user who
  sent the message as well as the owner. An administrator is read-only by default; after an explicit
  `chat` share the administrator is an ordinary `chat` participant. Scheduled tasks and API tokens
  work the same way.
- An approval request walks up the session tree to the first agent that allows the operation (the
  root session's agent included); when no agent allows it, or the agent escalates, the request goes
  to the root's owner. A user with a share cannot approve.

## Actors

Every task and every audit event records the actor and the user it represents:

| `actor_type` | `actor_id` | `on_behalf_of` |
|---|---|---|
| `user` | User id | The user |
| `session` | Session id | The session's owner |
| `subagent` | Child session id | The parent session's owner |
| `schedule` | Scheduled task id | The schedule's owner |
| `api_token` | Token id | The token's owner |
| `system` | Component name | — |

Every permission check starts from the `on_behalf_of` user: crhs first checks that this user can
access the target node, then walks the rule chain (see [Authorization rules](#authorization-rules)).
The actor type decides only how the operation is attributed.

## Authorization rules

The authorization rules of crhs decide whether an actor may start a task. The `privileged` field
separates privileged from ordinary tasks; without it a rule could not allow ordinary execution while
still sending privileged tasks to approval. On `native` and `ignore` nodes the crhs rules are the
only gate for a privileged task; on a `forward` node the node's privilege trust configuration makes
the final decision as well, so both must allow ([Privilege](privilege.md)).

### Rule chain

Users and organizations have no long-term rules. The root of a chain is an object that acts for a
user:

| Scenario | Rule chain |
|---|---|
| Manual execution in the WebUI | None: the user acts in person, and only node access is checked (administrator, or a grant). |
| Session | Root session → child session → … (each subagent is an independent session). |
| MCP | API token. |
| Scheduled task | Schedule → session (created per run) → child sessions → …. |

- A root — a root session, a scheduled task or an API token — is configured by a rule preset
  (`rule_sets.rule_preset`, API `rulePreset`), which supplies its `default`, plus the rules added on
  top. The preset is mapped to the rules the chain evaluates:

  | Preset | Rules |
  |---|---|
  | `ask` (Ask) | Allows non-privileged reads (`file.read`, including stat and directory listing). Everything else, including every privileged task, has `default = require-approval` and goes to the user. |
  | `auto_review` (Auto Review) | The same rules as `ask`, but an approval that would otherwise go to the user first goes to the review model (`review` model preset): it approves a clearly safe operation and sends anything risky or uncertain to the user. |
  | `yolo` (Yolo) | `default = allow`. |

- The preset's rules come before the rules added on the root, and both are part of the root's rule
  set. The owner can change the preset at any time. Choosing "always allow" during an approval
  appends an `allow` rule to the root: method, nodes, and an `exact` or `prefix` target, prefilled
  from the operation and editable. Only an allow rule may be appended this way.
- Rule changes are audited as `rules.changed`.
- A child session is created by its parent agent with a full rule set, so a subagent can be
  restricted finely; it can only tighten the level above. The parent decides the child's rules at
  creation, and the API rejects a `rulePreset` for a child session with 400.
- API tokens are roots of the same shape but may use only the `ask` and `yolo` presets (see [API
  tokens](#api-tokens)).

Rules are the boundary for delegating work to an agent; a user acting in person needs none. Presets
give a person a simple choice, and full rule sets give a subagent fine-grained limits.

### Rules

```json
{
  "default": "inherit",
  "rules": [
    { "action": "deny",             "method": "file.write", "nodes": ["prod"], "prefix": "/etc/crha/" },
    { "action": "allow",            "method": "exec", "nodes": ["web"], "prefix": "systemctl status " },
    { "action": "allow",            "method": "exec", "nodes": ["web-1"], "exact": "systemctl restart nginx" },
    { "action": "require-approval", "method": "exec" },
    { "action": "allow",            "method": "file.read" }
  ]
}
```

| Field | Meaning |
|---|---|
| `action` | `allow`, `deny` or `require-approval`. |
| `method` | `exec`, `file.read` or `file.write`, the same methods as crha. Omitted matches every method. `file.stat` and `file.list` are `file.read`; `file.edit` is `file.write`. `allow file.write` also allows reading the same target; `deny` and `require-approval` match only the write itself, so `deny file.write /etc/x` does not forbid reading the file. This follows crha's containment of write in read, without turning "do not modify" into "do not look". |
| `nodes` | A list of node and node-group references, as names or UUIDs, resolved to UUIDs on write (nodes and node groups share one namespace, see [Node groups and names](#node-groups-and-names)). `_all` is stored as written and means every node the acting user can access, evaluated when the rule is used; omitting the field matches every node, like `["_all"]`. Renaming an object does not affect a rule; a reference whose object was deleted is shown as a deleted node or node group. |
| `privileged` | `true` matches only privileged tasks, `false` only ordinary tasks; omitted matches both. Agent tools and MCP expose `privileged` on task calls. The "always allow" form prefills the rule with the privileged value of the task being approved. |
| `exact` / `prefix` | Matches the target: the rendered argv for `exec`, the normalized absolute path for a file operation, as in [Methods and targets](privilege.md#methods-and-targets). `exact` requires equality, `prefix` requires a prefix; omitted matches any target. The two fields are mutually exclusive. |
| `default` | The result of this level when no rule matches. A root uses `allow`, `require-approval` or `deny`, supplied by its preset. A lower level uses `inherit` (the default, no additional restriction), `require-approval` or `deny`; the root may not be `inherit`. |

crhs rules have no `regex` match. A rule runs on the crhs event loop, and one pathological expression
with heavy backtracking could stall the whole server; rules may also be written by an agent. crha's
trust rules use RE2 and are unaffected.

A rule set holds at most 200 rules. A `nodes` list that is present must not be empty; `exact` and
`prefix` are at most 1000 characters and are mutually exclusive; unknown fields are rejected.

### Evaluation

The rules are a permission ceiling that tightens at every level: the root sets the initial
permission, and each later level can only restrict it further.

1. Compute each level's own result `r`: the strictest matching rule in that level (`deny` >
   `require-approval` > `allow`), or the level's `default` when no rule matches.
2. Starting at the root, compute the effective result `e`: `e0 = r0`, then for each later level
   `ek = stricter(ek-1, rk)`, where `inherit` and `allow` both mean no additional restriction.
3. The effective result of the last level is the final result: `allow` dispatches, `deny` rejects,
   and `require-approval` waits for an approval.

A lower `allow` cannot widen a restriction set above it. It is meaningful only together with
`default = "deny"` or `"require-approval"` at that level, for example a child session that denies by
default and allows only `systemctl status`. An algorithm in which any level's `allow` suffices was
rejected because it lets a child widen its parent's restriction.

The evaluation is returned per level with `own`, `effective` and the matched rule, so the WebUI and
the approval view can show the whole chain. The last level's effective result is the decision.

### Environment and working directory

Rules match only the argv of an `exec` target or the normalized path of a file operation
(`posix.normalize`; symbolic links are not resolved here, and crha refuses them for privileged
tasks). The task's `env` and `cwd` do not participate in matching and are deliberately not
restricted.

This is a known complexity trade-off, and crhs rules are not a sandbox. With a rule that allows the
prefix `systemctl status`, a request that also sets `LD_PRELOAD` or `PATH` can execute arbitrary code
without approval. Including the environment and working directory in rule matching would add many
platform differences and new false allows, so the server does not do it. Use a `forward` privileged
node for strong isolation; there the trust entry's `env_allow` still validates the environment
([Trust entry fields](privilege.md#trust-entry-fields)).

### Approvals

- An approval is part of the state of the tool call itself. A task stops in `awaiting_approval`, and
  the decision — approved or rejected, the decider, the time, the reason, and each level's judgment
  — is stored on the task. A batch is approved once as a task group, and the decision is stored on
  the group. There is no separate approval table.
- Writing an approval also clears `handler_type` and `handler_session_id`: the task becomes allowed
  and waits for dispatch, leaves the user's and the agent's waiting lists at once, and a second
  decision or a rule change no longer treats it as waiting ([State
  machine](execution.md#state-machine)). A one-off decision is not a policy, so only "always allow"
  writes a rule; otherwise the decision stays on the task.
- A rule change on the chain (a new preset, an appended rule) makes crhs judge every waiting task on
  that chain again: `allow` records a decision and dispatches in the background, `deny` ends the
  task, and `require-approval` leaves it waiting. Waiting task groups are judged per node: when
  every node denies, the group is rejected; when no node still needs approval, the group is
  approved. Background dispatch keeps a rule-change request from waiting through the offline grace
  of each task.
- Each member of a task group is judged at creation against the current rules, whether the group
  runs directly, is approved by a person, or is approved by a rule change. The approval covers only
  `require-approval`; a `deny` still rejects, so a deny rule added after the approval applies. A
  member that would need approval at creation inside a running group does not wait: it ends as
  `rejected` with `error_code = approval_required`, and the group treats it as a failure under
  `fail_fast`.
- An approval has no deadline. It waits until the handling agent or the root's owner decides, until
  a rule change removes the need, or until the API token that started it is revoked or expires (the
  waiting request is then rejected; expiry is swept at startup and every five minutes). The system
  does not give up a user's decision for them, and there is no cleanup job to run.
- The request walks up from the level that raised it, and the root session's agent is an ordinary
  level of the walk:
  - If an ancestor's effective result is `allow`, the request goes to its agent, which can approve,
    reject or escalate. An agent escalates when the restriction was added at a lower level.
  - If an ancestor's effective result is `require-approval`, it is skipped and the walk continues
    upward.
  - If no ancestor allows, or the agent escalates, and the root preset is `auto_review`, the request
    goes to the review model (`review` model preset, see [Model
    presets](agent-runtime.md#model-presets)). When no review model is configured, the session uses
    its own model and a scheduled task uses the schedule's model. Otherwise the root's owner decides
    in the WebUI.

  A restriction a child adds is the agent's own guardrail, not an approval request aimed at the
  user, so the agent that added it can lift it; the root's preset still bounds what the root agent
  may approve.
- The review model sees only the operation, never the conversation or node output. It can approve or
  escalate, never deny; a model that does not answer through `submit_review` escalates.
- The handling agent decides in its own session: a foreground subagent's wait is interrupted and
  moved to the background, the parent handles the request and then waits explicitly ([Handling
  subagent requests](agent-runtime.md#handling-subagent-requests)). The decision is audited with the
  deciding agent session (or the user) as actor; after an escalation the user decides on the
  approvals page.
- A waiting request carries `root_session_id` (its session tree) and `handler_type` /
  `handler_session_id` (the agent session handling it, or `user` with no session; the user is the
  task's `on_behalf_of` user). The approvals page lists only `handler_type = "user"` requests;
  requests an agent is handling stay in the session and are not shown twice. A row with a null
  handler is not waiting for approval: it is the interval between approval and claim.
- The approval view always shows the complete rule chain and each level's judgment. When a node
  trusts only a user signature, that signature also counts as the crhs approval, so the user does
  not approve twice ([Waiting for signatures](privilege.md#waiting-for-signatures)).

## API tokens

An API token belongs to the user who created it, can be revoked at any time, and is stored only as
a SHA-256 hash; the secret is returned once, at creation. A token is `crh_` followed by 32 random
bytes in base64url. It has a name of 1–100 characters and a lifetime: 90 days by default, at most
365 days, or no expiry when created with `days: null`.

Authentication reads the token row on every request; an unknown token, a revoked token, an expired
token or a disabled user fails. Revocation and expiry therefore stop authentication at once.

Revocation and expiry reject the tasks and task groups the token started that are still waiting for
approval, through the same path as any approval decision, with the reason `the API token was
revoked` or `the API token expired`. Revocation does this in the request; expiry is handled at
startup and by a sweep every five minutes. The sweep is idempotent: a second run finds no waiting
row. Expiry ends only the waits; the tasks' history and the audit log remain.

A token is the root of the MCP rule chain. It can be created only with the `ask` or `yolo` preset:
Auto Review sees only the operation, and a token has no session or user instruction behind it, so an
operation-only review cannot stand in for the user's approval. The preset and the rules added on top
can be changed at any time. The token can access the same nodes as its owner.

A token cannot perform administrative actions. Tokens authenticate only the `/mcp` endpoint; user,
user group, model, node, node group and node access grant management require a WebUI session, so
even an administrator's token cannot change them.

Changing a password (by the user or by an administrator reset) can also revoke all of that user's
tokens, but does not by default: the default is only to end Web sessions. A user's own change keeps
the current session and ends the others; an administrator reset ends all of the user's Web sessions.

A token can be deleted only after it is revoked or expired. Deletion removes its rule set in the
same transaction. Tasks that already ran keep the rule chain stored on them, but the token level of
that chain can no longer be resolved.

## Audit

Every mutation that matters is recorded in `audit_events`. The authorization list
(`GET /api/authorizations`, the WebUI authorization page) is administrator-only and covers the
whole organization; a regular user may submit an authorization but cannot list the organization's.
The table is described in [Data model](data-model.md#audit).

Each event has a database-assigned `seq`, a timestamp, an actor (`actor_type`, `actor_id`,
`on_behalf_of_user_id`), an action (a dotted verb), an optional target (`target_type`, `target_id`)
and a `detail` JSON object with its keys in canonical order. The server appends; it never updates or
deletes a single event. The log is queried newest first and can be filtered by action, target type
and target id; an action ending in `.` is a prefix filter.

An administrator sees every event; every other user sees the events recorded on their behalf
(`on_behalf_of_user_id`). A task's or session's content is not copied into the audit: the log holds
metadata and references, and the complete session record lives in the durable tables.

### Recorded events

| Category | Events |
|---|---|
| Authentication | `auth.login`, `auth.login_failed`, `auth.logout`, `auth.password_changed`, `user.password_reset`, `api_token.created`, `api_token.revoked`, `api_token.deleted`, `credential.added`, `credential.removed` |
| Nodes | `node.enrollment_requested`, `enrollment_token.created`, `node.approved`, `node.connected`, `node.disconnected`, `node.renamed`, `node.node_groups_changed`, `node.deleted`, `node.trust_changed`, `node_group.created`, `node_group.renamed`, `node_group.members_changed`, `node_group.deleted`, `node_access_grant.created`, `node_access_grant.deleted`, `ssh_node.created`, `ssh_credential.created`, `ssh_credential.deleted` |
| Tasks | `task.created`, `task.finished`, `task.approval`, `task.review`, `task.agent_request`, `task.agent_escalated`, `task_group.created`, `task_group.approval`, `task_group.review`, `task_group.agent_request`, `task_group.agent_escalated` |
| Authorizations | `authorization.issued`, `authorization.submitted`, `authorization.cosigned` |
| Agent | `session.created`, `session.subagent_created`, `session.message`, `session.compacted`, `session.quota`, `session.quota_exhausted`, `tool.call` |
| Users | `user.created`, `user.updated`, `user_group.created`, `user_group.renamed`, `user_group.member_added`, `user_group.member_removed`, `user_group.deleted`, `session.shared`, `session.unshared` |
| Configuration | `rules.changed`, `schedule.created`, `schedule.updated`, `schedule.enabled`, `schedule.disabled`, `schedule.deleted`, `model_provider.saved`, `model_provider.deleted`, `settings.model_preset` |

`task.created` records the node, kind, policy result and input hash; `task.finished` records the
state, exit code, signal, error code, output size and the hash of the kept output. Approval
decisions, Auto Review verdicts and agent routing have their own events (`*.approval`, `*.review`,
`*.agent_request`, `*.agent_escalated`).

`tool.call` records which tool ran and through which surface (`session` or `mcp`). Model calls are
not audit events: their token counts and timing are session statistics (`sessions.usage_tokens`, the
`stat_*` columns; see [Session statistics](agent-runtime.md#session-statistics)).

### Tamper resistance

- The audit log is append-only and has no hash chain. A hash chain without a key can be recomputed
  from the point of modification by anyone who can write the database, so it would catch accidental
  edits and corruption but not a determined attacker; it would also make every append read the last
  row, store two hashes per row, verify with a full-table scan, and need an extra anchor before old
  records could be deleted.
- The database uses one application account, with the privileges that migrations, installation and
  runtime need. This keeps deployment simple. It also means the database cannot defend against a
  compromised crhs: whoever can modify the database can rewrite any in-database check, so there is
  no in-database tamper evidence.
- Records past `[retention].audit` are deleted; the newest 16384 sequence numbers are always kept
  ([Retention](data-model.md#retention)).
- On the node, crha's privileged mode writes a local log and also writes to journald. Even a
  compromised crhs cannot delete or alter the execution record of a privileged task on the node;
  tampering inside the host is outside the threat model.
- The intended way to make the audit tamper-evident is to export it to a trust domain outside crhs,
  such as syslog or a webhook.

## Extension points: OIDC

OIDC login is not implemented, but the design does not block it:

- Login and user identity are separate. A login method only answers which user this is; Web
  sessions and permission checks do not depend on it. `users.password_hash` is nullable, so an OIDC
  user can have no password.
- An implementation would add a `user_identities (user_id, provider, subject)` table to link an
  external identity to a local user, and either create a regular user on first login or allow
  linking only to an existing user.
- User groups could later be synchronized from an OIDC groups claim. `user_groups.source` is
  reserved for this and currently holds `local`.
- Privilege signing is independent of login. OIDC would only log in to the WebUI; issuing an
  authorization still uses the user's SSH key or Passkey ([Signing methods](privilege.md#signing-methods)).

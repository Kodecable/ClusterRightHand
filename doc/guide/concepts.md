# Concepts

ClusterRightHand (CRH) runs agent sessions on a server, crhs, and runs the commands they decide on
across your hosts. This page introduces the objects you work with.

## Organizations

CRH does not implement organizations yet. Every user, node and session belongs to one built-in
organization.

## Users, user groups and administrators

A user has a unique username. It is trimmed and lower-cased and must start with a letter (then up to 63
of `a-z`, `0-9`, `.`, `_` and `-`). Password login is currently the only way to sign in. SSH keys and
Passkeys are used only to sign privileged-task authorizations.

A user group is a named set of users that administrators maintain. Its name follows the same rule. You
can grant node access to a group or share a session with it. User groups do not nest.

An administrator is a user who manages users, user groups, nodes, node groups, SSH credentials and
model settings. Administrators can see every node, session and audit event without an access grant.
Another user's session is still read-only to an administrator unless it is shared with them for chat.

An administrator cannot change their own type or disable themselves, and crhs refuses any change that
would leave no active administrator. Disabling a user signs them out, invalidates their API tokens and
disables their scheduled tasks.

## Nodes and node groups

A node is a host that CRH runs tasks on. There are two kinds:

- **crha nodes** run the `crha` agent, which keeps a connection to crhs. A new crha node is pending
  until an administrator approves it.
- **SSH nodes** need only sshd. crhs connects to them when it has a task to run. They cannot run
  privileged tasks.

A node group is a named set of nodes. Groups do not nest and can mix crha and SSH nodes. You can use
a group wherever you choose nodes: in a rule, as a task target, or in an access grant.

Nodes and node groups share one set of names, compared case-insensitively. Renaming a node or group
keeps everything that refers to it. Deleting it and creating a new one with the same name does not:
the new one is a different object. Names starting with `_` are reserved; `_all` means every node you
can access.

## Node access

An administrator grants a user or user group access to a node or node group. Access lets you see the
node and run tasks on it, including privileged tasks. Access through a node group follows the group's
current members.

Nodes you cannot access do not appear anywhere in the WebUI or the API. Access is checked by crhs;
a node in `forward` privilege mode still checks privileged tasks against its own trust configuration.

## Tasks and task groups

A task is one command or file operation on one node. A task group runs the same task on several nodes
at once (at most 512) and is approved once as a whole. Each node's task has its own result, and a
failure on one node does not undo the others.

| State | Meaning |
|---|---|
| Awaiting approval | Waiting for someone to approve it under the rules. |
| Awaiting authorization | Approved, but the node is waiting for a signature or a local approval. |
| Dispatched, Running | Sent to the node, then running. |
| Exited | Finished with an exit code. A non-zero exit code is still Exited. |
| Failed | Could not run or complete. |
| Rejected | Refused by a person, cancelled before it started, or its wait expired. |
| Denied | Refused by a rule. |
| Unknown | crhs lost track of it, for example because the connection dropped. |

## Privileged tasks

A privileged task needs an authorization before the node runs it. Privileged does not mean root.
Each crha node chooses how it handles privileged tasks in `crha.toml`:

| Mode | Behavior |
|---|---|
| `reject` | Refuses every privileged task. This is the default. |
| `ignore` | Runs it like any other task. |
| `native` | Runs it as another identity through `sudo`, `doas` or `run0`. The node checks no authorization. |
| `forward` | Hands it to a separate privileged process that checks the authorization against its own trust configuration. |

Only `forward` protects the node from a compromised crhs: if the node trusts only user signatures or
local approval, crhs alone cannot make it run a privileged task. See [Security](security.md).

## Authorizations

An authorization is a signed permission to run privileged tasks on a `forward` node. It is separate
from a rule approval: the approval lets crhs send the task, and the authorization lets the node run
it. An authorization can be signed by crhs, by a user's SSH key with `crha grant`, or by a user's
Passkey in the WebUI. It always has a deadline, and it is either one-shot (for specific tasks) or
reusable (for any matching command until the deadline). A node can also approve a task locally
without a signature.

A task that waits for a signature is rejected after 24 hours.

## Rules and approvals

Rules decide whether an agent session, a scheduled task or an API token may start a task. A user
running a task directly in the WebUI needs only node access.

A session, scheduled task or API token starts from a rule preset:

- **Ask** allows non-privileged reads and asks you about everything else.
- **Auto Review** works like Ask, but a review model decides first.
- **Yolo** allows everything by default.

You can add rules on top of the preset. Each rule matches tasks and gives `allow`, `require-approval`
or `deny`. A subagent inherits its parent's rules and can only make them stricter. When a task needs
approval, the nearest parent agent that is allowed to run it may decide; otherwise the session owner
decides in the WebUI. Changing the rules re-checks every waiting task.

## Sessions and subagents

A session is a conversation with the agent. It belongs to the user who created it and can be shared
with other users or user groups. Shared messages still act as the owner.

A subagent is a child session that a session starts for part of its work. Subagents nest at most two
levels deep. A session can have a token quota; when it runs out, the session pauses and asks its
parent, or its owner, for more.

Each session chooses its own model. Administrators configure model providers and three model presets:
the default session system prompt, the Auto Review model and the session title model.

## Scheduled tasks

A scheduled task sends a fixed message to a new session on a cron timetable. The session uses the
schedule's rules and quota. Only one run of a schedule is active at a time: a new run stops the
previous one.

## API tokens

An API token lets an MCP client act for you. It is shown once, when you create it. A token can use
only the `/mcp` endpoint, can use only the Ask and Yolo presets, and reaches the same nodes as you.
Revoking a token, or letting it expire, rejects the tasks it started that are still waiting for
approval.

## Audit

crhs records every important change in the audit log. Administrators see all events; other users see
the events recorded on their behalf. The log holds metadata only, not command output or messages.

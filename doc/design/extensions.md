# Extensions

Agent sessions can use tools from outside CRH. An extension is always an MCP server that an administrator
connected; there are no in-process plugins, because those would need a sandbox, a compatibility promise
and their own audit path, and MCP already is the extension protocol. External tools go through the same
rules, approvals and audit log as cluster tools.

The scope of the first version:

- **Administrators connect servers.** A user cannot add a server, so every extension is a deliberate
  decision by someone who controls crhs anyway.
- **Streamable HTTP only.** A stdio server would run an arbitrary process on the crhs host, outside the
  Cluster API.
- **Static credentials.** A server gets fixed request headers. Per-user OAuth is not supported.
- **Agent sessions only.** crhs as an MCP server ([MCP](../guide/mcp.md)) does not forward external tools
  to its own MCP clients; those clients can connect to the external server themselves.

## MCP servers

| Field | Meaning |
|---|---|
| Name | Lowercase letters, digits and `-`, not starting with a digit; unique. Tools and rules use it |
| Description | Shown to the model with the server; defaults to the server's own `instructions` |
| URL | The Streamable HTTP endpoint |
| Headers | Sent on every request; encrypted with the master key and never returned by the API |
| Identity headers | Optional names of headers that receive the CRH username and session id |
| Enabled | A disabled server is invisible to sessions |
| List directly | Its tools appear in the model's tool list instead of only through search |
| Trust annotations | Use the server's tool annotations for rules (on by default) |
| Grants | The users and user groups who may use it |

- Changing the URL of a server with stored headers requires entering the headers again or removing them,
  the same rule as for model provider keys, so a credential cannot be sent to a new endpoint unnoticed.
- A server sees every CRH user as the one identity its headers carry. Identity headers let it tell them
  apart for its own logs; they are not authentication.
- A session reaches the servers its owner is granted. Session settings can turn single servers off; a
  new session has all of them on, because search keeps unused servers out of the context. A subagent
  inherits its parent's set and can only turn more off.

### Connections

crhs connects to a server when it is first needed and keeps one connection per server for all sessions.
It caches the tool list, refreshes it on `notifications/tools/list_changed`, on reconnect and when an
administrator asks.

- **Disconnects.** A dropped or failed connection is retried with exponential backoff (1 s doubling,
  with jitter, capped at 5 minutes); a successful connection resets it. An administrator's "reconnect"
  tries at once.
- **While unavailable.** The server stays in the session's server list marked unavailable rather than
  hidden, with the last error, so the model can tell the user. `search_tools` still searches the last
  known tool list and says it may be stale.
- **`call_tool` on an unavailable server** makes one immediate connection attempt (10 s connect
  timeout) instead of waiting for the next scheduled one. On success the call proceeds and the backoff
  resets; on failure the call fails with `unavailable` and the error, and the backoff schedule goes on.
  Concurrent calls share one attempt, and after a failed attempt in the last 10 s a call fails at once
  without trying again, so a looping model cannot hammer the server.
- **Calls in flight.** A connection lost during a call ends that call `unknown`, as a restart does;
  it is not repeated on the new connection.
- The settings page shows each server's state, last error and next attempt.

## Tools for the model

The tool list stays the same for the whole session. Tool definitions sit at the start of the prompt, and
adding or removing one would invalidate the prompt cache for everything after it. External tools are
therefore reached through two fixed tools:

| Tool | Purpose |
|---|---|
| `search_tools` | Keyword search over the available servers' tools (name, title, description). Returns the best matches with their full input schema and annotations. With `server` and no query, lists that server's tools by name and summary, paged |
| `call_tool` | Calls `tool` on `server` with `arguments` |

The session's tool guide lists each available server with its description, its tool count and whether
it is unavailable, so the model knows when a search is worth it.

A server marked "list directly" also contributes its tools to the tool list as `mcp__<server>__<tool>`.
This is for small servers used in most sessions. A tool whose combined name does not fit the providers'
name rules (64 characters of letters, digits, `_` and `-`) stays reachable only through search.
The direct set is computed from the current rows when a request is built, so changing the flag, a
server's grants or enabled state, or its tool list changes the tool list of new requests, which costs
one cache miss.

Search is plain keyword scoring without embeddings: it needs no model call, is deterministic, and tool
names and descriptions are short and written to be found.

## Rules and approvals

External calls use two rule methods, mirroring files:

| Method | Operation |
|---|---|
| `mcp.read` | A tool whose annotations say `readOnlyHint: true`, on a server whose annotations are trusted |
| `mcp.write` | Every other tool |

The target is `<server>/<tool>`, matched with the usual `exact` or `prefix`, so `prefix: "github/"`
covers a whole server. A rule with `nodes` never matches an external call, and external calls are never
privileged. As with files, `allow mcp.write` also allows `mcp.read` on the same target.

- The Ask preset allows `mcp.read` as it allows non-privileged file reads; Auto Review judges the rest;
  Yolo allows everything.
- Annotations are trusted because an administrator chose to connect the server. A server whose
  annotations are not trustworthy can be switched to "trust annotations: off", which makes all its
  tools `mcp.write`.
- Auto Review sees the server, the tool, its annotations and the arguments, never the conversation.

### External calls

Approvals belong to the object that waits ([Approvals](access-control.md#approvals)). A task is bound
to a node, its protocol spec and dispatch, so an external call gets its own small object instead:
`external_calls` holds the session, actor, server, tool, arguments, operation and the approval columns
tasks use, plus only the state that must survive while the call is in progress.

- Its id is derived from the tool call, like a task id, so a tool call that runs again after a restart
  finds the call instead of making it again.
- When it ends, the row keeps only its state and `finished_at` and clears its arguments: it is the
  "already ran" marker. The result is in the transcript and who decided is in the audit log. A replay
  after a restart returns "the call finished before a restart; its result could not be kept" instead of
  calling the server again.
- Terminal rows are kept for one day by a built-in retention policy, not a System setting, after which
  the sweep deletes them ([Retention](data-model.md#retention)). Rows still waiting or running are never
  deleted.
- An external call is not assumed to be idempotent. A call that was in flight when crhs stopped ends
  `unknown` and is never repeated.
- A call has a timeout (5 minutes by default, per server). Aborting the tool call or reaching the
  timeout sends an MCP cancellation.
- A waiting call goes up the chain like a task ([Approvals](access-control.md#approvals)): the nearest
  ancestor agent whose cumulative result is `allow` may approve, reject or escalate it. Auto Review, for
  an Auto Review root, and otherwise the owner answer when no agent may decide or the agent escalates.
- The decision panel and the approvals page show external calls next to tasks, with the server, tool,
  annotations and arguments. "Always allow" offers the exact tool or the whole server.
- Calls and their decisions are audited (`external_call.started`, `external_call.finished`, with the
  arguments truncated). Server changes are audited as configuration (`mcp_server.*`), without header
  values.

## Results

An external result is converted to the cluster tools' output form ([Tool output](agent-runtime.md#tool-output)):

- Text content is returned as text, truncated with the same limits, followed by a note block naming
  the server and tool. External content is untrusted like node output
  ([Prompt injection](agent-runtime.md#prompt-injection)).
- Images go into the image cache and reach the model as `view_image` results do
  ([Image cache](library.md#image-cache)).
- Structured content without text is returned as compact JSON. Resource links are listed by URI.
  Embedded binary resources and audio are described by type and size, not sent.
- `isError` sets the result's error flag. Files are not saved to a library automatically; the model can
  write what it needs.

## Extension points

- Per-user credentials (OAuth) for servers that act as the individual user.
- Forwarding external tools through crhs's own MCP endpoint, with API token rules.
- A meta tool budget: listing small servers directly by default once tool counts are measured in
  practice.

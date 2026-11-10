# Agent runtime

The agent runtime runs every session as a pi-durable `Conversation`. It owns session creation and
configuration, turns user input into model requests, exposes the Cluster API as tools to the model,
and records run state, token accounting and generation statistics. The rest of the server calls one
facade, and the WebUI receives the server's own API types rather than pi types.

This document describes the runtime as implemented. The surrounding components are in
[Architecture](architecture.md), the tool wire format in [Protocol](protocol.md), task execution in
[Execution plane](execution.md), authorization in [Privilege and authorization](privilege.md), and
ownership rules in [Users, ownership and audit](access-control.md).

## Why pi-durable

pi is layered. `pi-ai` is the provider-neutral LLM API; `pi-agent-core` is the in-memory agent loop;
`pi-coding-agent` is a coding harness around that loop; `pi-durable` is the durable harness built on
the same message and tool model.

```text
pi-ai                 provider, model catalogue and OAuth layer
  ├─ pi-agent-core       in-memory agent loop (Agent)
  │    └─ pi-coding-agent   local coding harness (CLI / SDK / RPC)
  └─ pi-durable          durable harness: conversations, tasks, crash recovery
       └─ pi-env            remote ExecutionEnv (separate Rust daemon)
```

CRH does not use `pi-env`: node execution goes through the Cluster API to crha or SSH. The runtime
is built on `pi-durable`, with `pi-ai` for model access. The match is direct:

| Requirement | pi-durable mechanism |
|---|---|
| Many sessions in one process | One `Harness` over one `Storage` manages many `Conversation`s, which can be forked |
| Continue after a server restart | Every step commits before it is displayed; `resume()` continues unfinished work; a tool call is a durable task |
| Subagents | A child is a separate conversation with its own state and abort scope; CRH makes child conversations ownerless so it can end a foreground wait without killing the child |
| Tool control | `hook(ToolTask, { beforeTool })` can block a call or replace its arguments; `afterTool` can add to a result |
| Idempotency | `submit` carries a `requestId`; a tool declares `replay: "safe"` and finds its earlier work after a restart |

`pi-coding-agent` was rejected as the base because its sessions are JSONL files, its configuration
and resources are discovered from the file system, it assumes one working directory, and it has no
built-in subagents. Its extensions (pi packages) use a different extension API from `pi-durable`, so
choosing the durable harness also means giving up that ecosystem. `pi-agent-core` alone was rejected
because persistence, compaction and subagents would all have to be built on top of it.

`pi-durable` is marked experimental and changes its API between versions. The runtime therefore
depends on it behind the server's own facade, pins exact versions, and keeps every direct pi import
inside two directories; see [Dependency versioning](#dependency-versioning).

## The AgentRuntime interface

`server/src/agent/runtime.ts` defines `AgentRuntime`, the only agent object the rest of the server
uses. It owns one `Harness` over one `Storage`; every CRH session is a `Conversation` in that
harness. The public calls are:

```ts
// Abridged: parameter objects and result types live in runtime-core.ts and @crh/api.
class AgentRuntime {
  createSession(owner, input): Promise<SessionView>;
  createSessionWithMessage(owner, input): Promise<{ session: SessionView; created: boolean }>;
  submit(sessionId, by, text, requestId): Promise<string>;
  abort(sessionId, by?): Promise<void>;
  watch(sessionId, onEvents, signal?): Promise<() => void>;
  configure(sessionId, change): Promise<SessionView>;
  compact(sessionId, by, instructions?): Promise<CompactTask>;
  waitForSubmission(id, signal?): Promise<{ status: "done" } | { status: "unanswered"; reason: string }>;
}
```

The code defines this surface as a class; there is no separate TypeScript interface and
implementation. The same facade exposes `createSubagent`, `startSubagent`, `waitSubagent`, `subagentSessions`,
`isDescendant`, `pendingAgentRequests`, `decideAgentRequest`, `decideRootQuota`, `waitForQuota`,
`refreshState`, `entriesPage` and the session-list event hub. Internally it delegates by concern:
session rows in `runtime-sessions.ts`, run state in `runtime-state.ts`, submissions and manual
compaction in `runtime-submissions.ts`, subagent requests and wakes in `runtime-requests.ts`,
`runtime-subagents.ts` and `wakes.ts`, quota pauses in `runtime-quota.ts`, and model requests,
tools and hooks in `extension.ts`.

pi packages are implementation details. Direct imports of `@earendil-works/*` are allowed only in
`server/src/agent/` and in the storage adapters under `server/src/storage/`. The WebUI never sees a
pi type: `server/src/agent/session-events.ts` converts events field by field into the types in
`@crh/api`. `server/test/pi-boundary.test.ts` scans `server/src` for pi imports outside those two
directories and also asserts that it still finds the imports it polices, so a broken scan cannot
pass silently.

## Storage

The durable tables live in the same database as the business tables, so a deployment has one
database to back up and one set of credentials. pi-durable ships no PostgreSQL backend, so the
PostgreSQL implementation is maintained in the repository; the SQLite implementation is the
official one and is not forked. This is why there are two storage paths with one contract.

- **SQLite.** The runtime opens the official `SqliteStorage` with
  `SqliteStorage.open(db, { prefix: "pi_" })` on its own connection to the same database file.
  `node:sqlite` is synchronous, and the two connections cannot each block waiting for the other:
  both share one in-process statement queue, and a Kysely transaction begins with `BEGIN IMMEDIATE`
  and holds the queue until it commits or rolls back. When the Harness reopens, the previous storage
  is closed first. The official SQLite storage is followed upstream rather than patched.
- **PostgreSQL.** `PgStorage` (`server/src/storage/pg-durable/`) is a port of the official SQLite
  storage to the `pg` driver. Records remain TEXT holding JSON, because JSONB rejects lone-surrogate
  escapes and reorders keys. IDs are BIGINT, commits are serialized in process, and one commit batch
  runs in one transaction on a pooled client. Reads use the pool, and a document read uses one
  `REPEATABLE READ` snapshot. Business queries go through Kysely; `PgStorage` has its own `pg` pool
  and does not share a transaction with them. The adapter also adds the generated `search_text`
  column used by session content search; see
  [Data model](data-model.md#conversation-content-search).
- **Conformance.** CI runs the official `registerStorageConformance` suite against both dialects,
  so both implementations are held to the same storage contract.
- **Prefix and database.** Every durable table and index carries the `pi_` prefix and lives beside
  the business tables. The prefix is also what lets the session search query name `pi_entries`
  directly.
- **One opener.** pi-durable assumes a storage is owned by one process. On PostgreSQL, `PgStorage`
  takes a session-level `pg_try_advisory_lock` on a dedicated connection and refuses to open when
  another owner holds it. If the lock connection is lost, the storage rejects every later
  operation. On SQLite, crhs is the only process.
- **No shared transaction.** A durable commit cannot join a business transaction. The two sides are
  kept consistent by idempotency instead: the client's `requestId` makes a retried create or submit
  land once, and a Cluster task id derived from the durable tool task id makes a replayed tool call
  find its earlier task rather than create a second one.

## Model configuration

Administrators configure model providers on the [Models page](webui.md#models-page). A provider is
one of two kinds, stored in `model_providers.kind`:

- **Built-in (`builtin`).** The provider comes from pi-ai's `builtinProviders()` (DeepSeek,
  Anthropic and the rest). Its model list, context windows, thinking support and level mapping come
  from pi-ai and move with the pi-ai version. crhs supplies the API key and an optional `baseUrl`
  override. Only API keys are supported: pi-ai's subscription OAuth flows need server-side login,
  refresh and token storage for personal subscriptions, which does not fit a multi-user server.
- **Custom (`custom`).** Any endpoint that speaks one of the supported protocols. The administrator
  gives the base URL, optional key, optional extra headers, optional session-id fields and the model
  list. pi-ai already implements both protocols and carries their compat schemas; the custom form
  exists because gateways spell thinking parameters differently, and URL-based detection alone
  cannot correct them.

API keys are encrypted with the server's master key and stored in `secrets`; the provider row keeps
only the secret reference. No API response returns the key itself. Model configuration is read from
the database only; environment variables cannot silently change a provider. Cost is not configured
or tracked, and there is no separate compaction model: a session's compaction uses that session's
own model.

### Custom providers

A custom provider has these provider-level fields:

| Field | Meaning |
|---|---|
| `baseUrl` | An http(s) endpoint, for example `https://opencode.ai/zen/v1` |
| API key | Optional; a local endpoint without authentication may omit it |
| `headers` | Extra request headers, for gateway routing only. Credentials belong in the API key. The headers are stored and returned in plain text and are not treated as secrets |
| `sessionId` | `{ headers?: string[], body?: string[] }`: these request headers or body fields (dot paths such as `metadata.session_id`) receive the **CRH session id** of the request. A subagent sends its own id; Auto Review and title generation send the id of the session being reviewed or titled |

Changing the `baseUrl` of a provider that already has a stored key requires the request to carry a
new, non-empty `apiKey` (compared after normalization) or to remove the stored key; otherwise the
request fails with 400. A key stored for one endpoint must not be sent silently to another. A
provider that never stored a key is exempt, and changing only the headers needs no confirmation.

Each model entry has these fields:

| Field | Meaning |
|---|---|
| `id`, `name?` | The upstream model id and an optional display name |
| `api` | `openai-completions` (Chat Completions) or `openai-responses` (Responses) |
| `contextWindow`, `maxTokens` | The context window and the maximum output tokens of one request; automatic compaction uses `contextWindow` |
| `input` | `["text"]` or `["text", "image"]`. Images are wired through the model layer; the composer and submission path have no attachments |
| `thinking?` | Absent means no thinking, so only `off`; see below |
| `compat?` | Advanced: validated with pi-ai's `CompatSchemasByApi[api]` for the chosen protocol (for example `maxTokensField`, `supportsDeveloperRole`). Fields left out keep pi-ai's URL-based detection |

`thinking` takes one of two forms:

- **Standard:** `{ mode: "standard", format?, levels, labels? }`. pi-ai generates the thinking
  parameters. `format` applies only to Chat Completions and is one of pi-ai's `thinkingFormat`
  values (`openai`, `deepseek`, `qwen`, `openrouter`, `chat-template` and others); when omitted,
  pi-ai detects it from the URL. Responses always uses `reasoning.effort`. `levels` is the level
  map (`{ "<level>": "<value sent upstream>" }`). Unlisted `minimal`–`high` levels are sent as
  their ids; `xhigh` and `max` are available only when the level map or a non-empty display name
  gives them a value. `null` still means unsupported in the stored form, and the UI uses an empty
  display name to hide a level.
- **Custom:** `{ mode: "custom", levels, labels? }`. `levels` maps each level to a JSON object that
  is deep-merged into the request body after pi-ai has built it (`onPayload`). For example:
  `{ "off": { "thinking": { "type": "disabled" } }, "high": { "thinking": { "type": "enabled", "budget_tokens": 16000 } } }`.
  The available levels are `off` plus the listed keys, minus hidden levels; when `off` is not
  listed it merges nothing. pi-ai's own thinking parameters are removed in this form, including
  for a level with no body entry.

`labels` gives display names per level. A custom model exposes them through `thinkingLabels` in
`/api/models`; a built-in model uses the UI's translated standard names. Without a label a level
shows its id, except `xhigh` and `max`, which are hidden by default when they have no mapped value.
An empty string hides a level. `xhigh` or `max` with a non-empty display name but no mapped value is
offered like any other supported level and sent as its id. `off` can be renamed but not hidden.
Reasoning content parsing (`reasoning_content` and similar fields) remains pi-ai's job in both
forms.

### Thinking levels

- The levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, matching pi-ai. A
  model's available levels come from `getSupportedThinkingLevels`; for a custom model, the stored
  `thinking` configuration is first mapped onto pi-ai's model fields, and the same function then
  computes the set.
- A session, a subagent and a scheduled run use `{ provider, modelId, thinkingLevel? }`. An absent
  level is `off`.
- An explicitly given level must be available for the model, otherwise the request fails with 400.
  When only the model changes, the previous level is kept and clamped to the nearest available
  level with pi-ai's `clampThinkingLevel` (search upward first, then downward).
- A session view's `model` always carries the effective `thinkingLevel`. Every entry of
  `GET /api/models` carries the available `thinkingLevels`, the `input` kinds, and, for a custom
  model, `thinkingLabels`.

## Cluster tools

The cluster tools are defined once in `server/src/tools/catalog.ts` as a `ToolCatalog`: a name, a
description, a JSON Schema generated from a zod v4 schema, an output kind, and a handler that
returns a uniform result (content blocks, an error flag, and `details` for the UI). The same
definitions are adapted to pi-durable's `defineTool` for agent sessions and to the MCP SDK's
`registerTool`, which accepts the same zod schema, so the two surfaces cannot drift; the MCP facade
uses the stateless `createMcpHandler`, so each request carries its API token and gets its own tool
context.

| Tool | Category | Output | Arguments and behavior |
|---|---|---|---|
| `list_nodes` | non-task | JSON | The nodes the session owner can access, with node groups, status, online state and the privileged mode |
| `node_info` | non-task | JSON | `targets`: node Facts plus each node's notes path and a truncated copy of the notes |
| `exec` | CRH task, background-waitable | text | `targets`, `cmd` or `argv`, `cwd` (default `/`), `env`, `stdin`, `privileged`, `timeout`, `wait`, `with_output` (default true), `max_lines`, `max_bytes` |
| `read_file` | CRH task, blocking | text | `targets`, `path`, `offset` (1-based, default 1), `limit` (default 2000), `max_bytes`; one page is at most 2000 lines or 50 KiB |
| `write_file` | CRH task, blocking | JSON | `targets`, `path`, `content`, `overwrite`, `mode` (octal string such as `"0644"`), `create_parent_dirs` (like `mkdir -p`); by default only a new file is created |
| `edit_file` | CRH task, blocking | JSON | `targets`, `path`, `edits[]` with `old_text` and `new_text`; each `old_text` must be unique, and all edits on a node apply together or not at all |
| `list_dir` | CRH task, blocking | JSON | `targets`, `path`, `limit` |
| `stat` | CRH task, blocking | JSON | `targets`, `path`; returns type, size, mode, owner, group, modification time and link target |
| `task_wait` | non-task | same as `exec` | Continue waiting for an `exec` task or task group |
| `task_cancel` | non-task | JSON | Cancel an `exec` task or task group |

`task_wait` and `task_cancel` only reach `exec` tasks and groups started by this session or API
token, and by sessions in this session's subtree; another session of the same user cannot see them.
This follows the rule that a task belongs to the actor that started it (see
[Actors](access-control.md#actors)). File-tool tasks are never exposed to the model, so `task_wait`
does not accept them.

### Tool categories and shared components

The categories exist only in the tool layer. The task layer is unchanged: a file operation is still
a CRH task, with the same audit, rules, approvals, privilege authorization and restart reattachment
as any other task.

- **CRH task tools:** `exec`, `read_file`, `write_file`, `edit_file`, `list_dir` and `stat`. Every
  call creates a CRH task or task group. They share one component that resolves `targets`, decides
  between one task and a group, derives task ids from the tool call id, waits, and hands the result
  to a renderer. The component has two waiting modes:
  - **Background-waitable (only `exec`):** wait at most `wait`; after that return a still-running or
    waiting-for-approval/signature result with `task_id` or `task_group_id`, which the model follows
    with `task_wait` and can end with `task_cancel`.
  - **Blocking (the file tools):** wait until the task ends, including approval and signature
    waits. There is no `wait` parameter, no timeout and no task id in the result. A file operation
    normally finishes in seconds, and exposing an id would only add a `task_wait` round. Aborting
    the tool call (the agent is aborted, the MCP request closes) cancels the task.
- **Non-task tools:** `list_nodes`, `node_info`, `task_wait` and `task_cancel`. `node_info` reads
  notes through an internal read-only task, but only when the rules allow the read outright; it
  never leaves an approval request behind and is still a non-task tool.
- **Renderers** are shared too, one for text and one for JSON; see [Tool output](#tool-output).
- Both waiting modes push the task id and wait state to the UI through `onStatus`. The WebUI uses
  those ids to follow a tool card (see [Session interface](webui.md#session-interface)), while the
  ids do not enter the model's content.

### Naming

- Arguments and JSON fields are snake_case, including `node_groups`, `edits[].old_text`,
  `edits[].new_text`, and the `facts` returned by `node_info`, whose keys match the protocol's
  `Facts` (see [Events](protocol.md#events)).
- Every node-scoped tool uses `targets`, resolved the same way; there is no separate `node`
  argument. `targets` accepts node and node-group names or UUIDs, and `_all`.
- `write_file`'s `mode` is an octal permission string such as `"0644"`, and `stat` returns the same
  form. An invalid value is rejected with `invalid_argument`. JSON has no octal literal, and a
  decimal integer is easy to get wrong (`644` is `0o1204`).
- Error codes are snake_case and shared with a task's `error_code`, for example `node_offline`,
  `not_found`, `permission_denied`, `line_too_long` and `offset_out_of_range`. The tool layer adds
  `invalid_argument` (a bad argument combination), `no_such_node` (the node is not visible) and
  `no_such_task`.

### Batch execution

`node_info`, `exec`, `read_file`, `write_file`, `edit_file`, `list_dir` and `stat` accept several
targets. `targets` is a list of node and node-group names or UUIDs, for example
`["web-1", "prod"]`, or `_all`.

- **The result shape depends only on the input, never on how many nodes a group resolves to:**
  - exactly one entry that is not a node group: one task, and that task's result;
  - more than one entry, or any node-group entry (even one that resolves to a single node): a task
    group with one result per node.
  The batch parameters `parallel` and `fail_fast` are ignored for a single task.
- Optional parameters: `parallel` (nodes run at once, default 10) and `fail_fast` (start no more
  nodes after a failure).
- The Cluster core creates one **task group** per batch call and one task per node, so the audit log
  can be queried by group.
- A task group can be cancelled as a whole: stopping the session, aborting a blocking file-tool
  call, or `task_cancel(task_group_id=…)` sets an in-process stop marker. Workers create no further
  nodes, created members end as cancelled, and the group ends `cancelled` (see
  [Task cancellation](execution.md#task-cancellation)). `task_wait` and `task_cancel` both accept
  `task_group_id`.
- `exec` returns output by default (`with_output: true`). Each node keeps the tail of its stream,
  8 KiB or 128 lines by default, within one shared budget of 50 KiB or 2000 lines for the whole
  group. Grants are allocated in arrival order; once the budget is exhausted, later nodes get
  nothing and a whole node's output may be dropped. On a crha node the complete output remains in
  its output file.
  The `exec` tool chooses whether it returns output: `with_output: true` (the default) returns
  `text`, and `false` returns `status`. For a task group, the Web API's own default when
  `outputMode` is omitted is `status`, described with the other output modes in
  [Batch output](execution.md#batch-output).
- With `with_output: false`, both a single task and a batch return only the state, exit code and
  the path of the complete output file (JSON), with no output. A crha node always writes its output
  to disk; an SSH node has no complete output file, so its status carries no path.
- File-operation groups always keep each node's **head**: 8 KiB or 128 lines per node by default,
  within the same 50 KiB or 2000-line shared budget. Each node of a `read_file` batch carries its
  own line range and continuation offset; there is no common offset across nodes. A node whose
  output was dropped from the budget says so, so it can be read again on its own. `write_file`,
  `edit_file`, `list_dir` and `stat` have no page to keep; their results come from the task's
  `result` and are not subject to the budget.
- `edit_file` judges each node independently: a missing or non-unique `old_text` fails only that
  node, and the other nodes still complete. Several edits on the same node still apply together or
  not at all.
- `node_info` returns one entry per node. Notes keep each node's head under the per-node budget
  (8 KiB or 128 lines, shared 50 KiB or 2000 lines); a single node still shows at most 8 KiB.
- The `read_file` continuation hint is `Use offset=<n> to continue.` For one task, `n` is the line
  after the node's page. In a batch it is the line after the last line **kept** for that node.
- The budget is checked while output is appended, so memory does not grow with the number of
  nodes. A dropped node still receives an output and exit acknowledgement. Failing nodes are not
  preferred: their full output is read from the node file.
- **Per-node budgets.** `exec`'s `max_lines` and `max_bytes` replace the default per-node 8 KiB or
  128 lines. They may be smaller or larger, but not above the group budget of 50 KiB or 2000 lines;
  for example, `max_lines: 1` returns only each node's last line and still fits 512 nodes. For a
  single task they cap the tail given to the model, also within 50 KiB or 2000 lines. `read_file`
  has no separate line budget: `limit` is the number of lines read on the node (default 2000) and,
  in a group, also that node's line budget; when `limit` is omitted the budget is 128 lines.
  `max_bytes` gives the byte budget.
  `with_output: false` together with either budget is rejected with `invalid_argument`. Raising the
  per-node cap lets an early node take more of the total; grants still follow arrival order.
- An offline node fails with `node_offline` after the reconnect grace expires (see
  [Node offline](execution.md#node-offline)) and counts towards `fail_fast`.
- When some nodes pass and some are denied authorization, the tasks are independent: executed
  tasks are not rolled back, and `fail_fast` only stops nodes that have not started.
- Rules are evaluated per node. When approval is needed, one request covers the whole task group.

### exec tool semantics

- **Long tasks.** When a wait exceeds `wait` (600 seconds for an agent, 30 seconds for MCP, at most
  600), the tool returns the output so far and a still-running note with `task_id`. The agent then
  follows with `task_wait` instead of holding one tool call open.
- **Process groups.** When a task ends, its whole process group is cleaned up, so background
  processes started by the task do not survive, including tasks that ran as root. A service that
  must keep running is started with `systemctl` or `setsid`, outside the task's process group.
- **Reattachment after a restart.** Every CRH task tool declares `replay: "safe"`. The Cluster task
  id is derived deterministically from the durable tool task id, so when the server restarts and
  the tool runs again it finds the same Cluster task, still running or already finished, instead of
  creating another one.
- **`unknown` results.** The result is an error explaining that execution failed and its outcome is
  unknown, with the reason `connection_lost`, `executor_restarted` or `dispatch_unconfirmed`.
- **Waiting for approval or a signature.** The agent keeps waiting and pushes the wait state and
  link to the UI through `api.details`; MCP waits within its `wait` and then returns the wait state,
  the link and `task_id`. File tools keep waiting on both surfaces.
- **The id is pushed before the first wait.** After a task or group is created and before waiting,
  the tool pushes `{ task_id, state }` or `{ task_group_id, state }`. Later approval and signature
  waits push states with links. The WebUI uses this id to follow the task's final state and to stop
  a loading indicator even when the tool call never returns a result. MCP callers have no
  `onStatus`, so nothing is pushed and the task is not read an extra time.

### Tool output

**Text output** is used for raw content: `exec` (and the `task_wait` that follows it) and
`read_file` pages. The raw text is not escaped into JSON, which would make the model reconstruct it
before reading and make `edit_file` matching error-prone. A result consists of two kinds of content
blocks:

- **Raw block:** the output or page text, unescaped and not wrapped in JSON; omitted when empty.
- **Note block:** a few fixed-format lines that explain the node, the state and how to continue.
  Every line is wrapped in square brackets, and fields inside a line are separated by `, ` (a comma
  followed by one space). This lets a client that joins several blocks still tell which text was
  synthesized. Examples:
  - `[web-1, exit 0]`
  - `[web-1, exit 2]`, `[web-1, timed out after 30 s]`, `[web-1, killed by SIGKILL]`
  - `[Showing lines 1201-3200 of 3200. Full output: /var/lib/crha/output/<task_id>.log (read it with read_file).]`
  - `[web-1, still running, task_id <id>. Call task_wait with this task_id.]`
  - `[web-1, waiting for approval: <url>, task_id <id>. Call task_wait with this task_id.]`
  - `[web-1:/etc/hosts, lines 1-20 of 20 (end of file)]`,
    `[web-1:/var/log/syslog, lines 1-2000. Use offset=2001 to continue.]`
  - `[error not_found: open /nonexistent: no such file or directory]`
  - `[task group <id>, 4 nodes, 4 succeeded, 0 failed]`
  - A task `notice` (for example, an SSH node ignoring `privileged`) is appended as one or more
    bracketed note lines.
- A task group has one note/raw pair per node, never two nodes in one block, so text inside a node's
  output cannot be confused with a separator. A group note comes first and gives the group id, the
  node count and the success and failure counts.

**JSON output** is used for lists and facts: `list_nodes`, `node_info`, `write_file`, `edit_file`,
`list_dir`, `stat`, `task_cancel`, and `exec` with `with_output: false`. JSON is not indented.

**`exec` output** has one stream. crha joins the command's stdout and stderr into one pipe (the
equivalent of `2>&1`), and an SSH node does the same in its remote wrapper. The model receives the
tail of that stream: 2000 lines or 50 KiB, whichever comes first, starting at a whole line. When
the output is truncated, the note block gives the range and the total: `Showing lines X-Y of N. Full
output: <path>`. For a crha node, N is reported by crha in `task.exit` as `output_lines` (see
[Events](protocol.md#events)); X–Y is the part of the tail crhs kept. An SSH node has no complete
output file and crhs counts the lines itself; the note says so. Without truncation, no line numbers
are written. A batch with output writes the same `X–Y of N` note for each node.

**A `read_file` page** is returned as the file's own bytes, including its newlines. The note gives
the page's line range. The total line count is reported only when the page reaches the end of the
file; otherwise the note says `Use offset=<n> to continue.`

**Error results.** The following set the result's error flag (the agent's `isError`, MCP's
`isError: true`) while still carrying any output produced: bad arguments or targets, a failed task
with an `error_code`, a denial, a non-zero `exec` exit code, a timeout, a signal, and an `unknown`
state. A text tool writes `[error <code>: <message>]` in its note block; a JSON tool returns
`{"error": {"code": …, "message": …}}`. Tool-layer errors (arguments, targets) carry codes the same
way. A task group is an error if any node failed; each node's note or JSON entry still says whether
that node succeeded.

**`details` for the UI.** An agent tool result also carries a `details` object: task and group ids,
states, each node's task id and state, and error codes. The WebUI's tool card uses it to link to
the task page and to decide success or failure without parsing the model's text. `details` is not
sent to the model. MCP returns content blocks only.

## Sessions

A session belongs to the user who created it. What it may do is decided by its owner's node access
grants and the authorization rules on its actor chain, and a level that has a token quota is also
limited by that quota; see
[Authorization rules](access-control.md#authorization-rules) and
[Quota and token accounting](#quota-and-token-accounting). Sharing a session does not change whose
identity it acts under.

A session is a row in `sessions` plus a durable `Conversation` referenced by `conversation_id`. The
row carries the owner, title and `title_pending`, the model reference, the status, the parent and
root session ids, the run state (`state`, `waiting_kind`, `waiting_level_id`), the remaining quota and
the token counters. The columns are listed in [Data model](data-model.md#agent).

- **Creation on the first message.** A user-created session starts as an empty composer page in the WebUI and is
  created by `POST /api/sessions` together with its first message:
  `{ requestId, model, rulePreset, budgetRemaining?, title?, message }`. `requestId` is generated by
  the client for each new session. The pair of the owner and the request id is unique: repeating the
  request with the same id returns the session the first attempt created, without a second
  submission. The first submission's request id is derived from the create id, so retrying the
  submit is idempotent too. A create request without a non-empty `message` is a 400.
  If the submit fails after the row exists, the runtime aborts the conversation (durable has no
  conversation deletion, so its records remain unreferenced), forgets the session's caches, tells
  the session-list stream that the row is removed, and deletes the rule set and the row in one
  transaction before returning the error.
- **Configuration.** The owner can `PATCH /api/sessions/:id` to change the title, the model, the
  remaining quota and a root session's rule preset. The SQL writes commit in one transaction; the
  conversation's model and thinking level are configured afterwards, because the durable connection
  would wait for that transaction's SQLite write lock (see [Data model](data-model.md#storage-backends)).
  If the conversation rejects the model change, the row is restored in a compensating transaction,
  so a reader never sees a configuration the conversation does not have. A subagent's rule preset
  comes from its parent; sending `rulePreset` for a subagent is a 400.
- **Title.** A session's title is generated or chosen by the user; see
  [Title generation](#title-generation). Until then it is `null`, and the WebUI shows its localized
  default (`New Session` / `新会话`) without storing that text.
- **Event stream.** The WebUI subscribes to a session through `watch`; `GET /api/sessions/:id/events`
  pushes a snapshot and then batches of committed events. System messages (the system prompt and the
  tool schemas) are filtered out of the stream. Older history is paged separately; see
  [Session event stream and history](webui.md#session-event-stream-and-history).
- **Automatic compaction.** It is enabled, with thresholds derived from the model's context window;
  the parameters are in [Defaults](#defaults).
- **Manual compaction.** The user can send `/compact [instructions]` in the composer or call
  `POST /api/sessions/:id/compact` with `{ instructions? }` (at most 2000 characters) and chat
  access. The runtime calls durable's `compact()`: the summary is generated in the background and
  placed immediately when the session is idle, or at the next round boundary otherwise. The summary
  is charged to the session like any other model call, and the request is rejected when the chain's
  quota is exhausted. The call writes the `session.compacted` audit event and waits up to 2 seconds
  for an `outcome`:
  - `started`: compaction has started or already completed a summary;
  - `nothing`: there is nothing to compact, because the recent window (about 20,000 tokens with the
    default `keepRecentTokens`) already holds the whole history;
  - `failed`: the summary task failed.

  The WebUI prompts only for `nothing` and `failed`; a long summarization continues in the
  background after `started`.
- **Sharing.** A session can be shared with users or user groups at `view` or `chat` access. A
  shared user's message still runs as the owner; the audit log records the user who sent it. See
  [Ownership, access grants and sharing](access-control.md#ownership-access-grants-and-sharing).
- **Search.** Session content search covers root sessions and matches every whitespace-separated
  keyword in the title or the message text. Titles are searched on both backends. Message text is
  searched only on PostgreSQL, where `PgStorage` adds a generated `search_text` column to
  `pi_entries`; on SQLite the API reports `contentSearch: false` and returns no hits. The query and
  result shape are in [Session content search](webui.md#session-content-search); the column is in
  [Data model](data-model.md#conversation-content-search).

## Model presets

"Preset" always carries its qualifier. A **rule preset** is `ask`, `auto_review` or `yolo`
(`rule_sets.rule_preset`, API `rulePreset`, code `RulePreset`; Ask, Auto Review and Yolo in the
UI). A **model preset** is one of the
three settings below, stored in `model_presets`, one row per organization and kind. The distinction
matters because the API, the code and the UI all carry both names.

| Preset | Model | System prompt | Fixed protocol text |
|---|---|---|---|
| Session | Not set; every session chooses its own | Optional | Tool guide |
| Auto Review | Optional, including a thinking level; when unset, the root session's or schedule's model and level | Optional | The `submit_review` tool definition and the instruction to answer through it |
| Title generation | Optional; when unset, the session's model. The thinking level is fixed to the lowest available | Optional | The title output format |

The system prompt is the custom prompt, or the default prompt when none is set, followed by the
protocol text. The protocol text is fixed in code and cannot be edited: it carries what the model
must know to use the tools or produce a parseable answer. The session's own `instructions` (for
example, a subagent's delegation brief) follow the session system prompt.

A change takes effect on the next model request for every session. The runtime caches the presets in
memory and reloads the cache after each write, so the prompt sections can be read synchronously while
a request is prepared.

Auto Review answers through a tool call. The request offers one tool,
`submit_review({ decision: "approve" | "escalate", reason: string })`. The arguments are validated
against the schema; `reason` is cut to 300 characters. Only an explicit `approve` approves. A text
answer or a missing `submit_review` call escalates to the user; the runtime never parses a decision
out of prose.

The forced-tool mechanism depends on the thinking level. At `off`, the request forces
`submit_review` through the tool-choice form of the model's protocol (a named tool or function,
`any` for Gemini, `required` for Codex Responses). At a thinking level,
some providers reject a forced tool together with extended thinking, so the tool is offered with
`auto`; a text-only answer escalates. Either way, only a schema-valid tool call decides.

Session runs and Auto Review have no extra timeout of their own; the provider SDK's request timeout
applies. The Harness retries a failed model request up to 3 times after the first attempt, with a base delay
of 2 seconds and a server-requested wait of at most 60 seconds. Title generation
is the exception, with a 180-second limit; see [Title generation](#title-generation).

Administrators read and write the presets through `GET /api/model-presets` (all three, with
`defaultPrompt` and `protocol`) and `PUT /api/model-presets/:kind`, where `kind` is `session`,
`review` or `title`. Omitted fields stay unchanged and `null` clears them. The session preset does
not choose a model. Auto Review runs only for a root whose rule preset is `auto_review`. An API
token root never uses it: a token has no session or user instruction behind it, so an operation
that needs approval always goes to the user.

### Title generation

`sessions.title` may be `null`; the WebUI shows the localized default and the database stores
nothing. `sessions.title_pending` says that a title still wants generating. The latest round is a
short and cheap input, and a user's manual title always wins over a generated one.

- A user-created root session sets `title_pending` to true when it is created without a title and to
  false when a title is given. A subagent's title is the beginning of its delegated task, a scheduled
  run's title is the schedule's name, and neither generates a title.
- When a root session's run ends with an answer and `title_pending` is true, the runtime generates a
  title in the background without blocking the session.
  - The input is the latest user input and the run's final answer. Only text is used (no thinking,
    tool calls or tool results), and each side is cut to 2000 code points.
  - The output is the first non-empty line, with surrounding quotes or brackets and trailing
    punctuation removed, cut to 60 code points. An empty result is a failure. The language follows
    the user's input.
  - The title is written with one conditional `UPDATE` that rechecks `title_pending`, so the check
    and the write are atomic. A manual rename during generation clears the flag and wins; the
    generated title is dropped. A successful write also updates `updated_at` and publishes the
    session.
  - The call has a 180-second limit: `timeoutMs` bounds each provider SDK request, and an abort
    signal stops a stream that has started but stalls. A timeout follows the failure path.
  - A failure (model error, empty output, or an already exhausted quota, in which case the call is
    skipped) only logs; `title_pending` stays true and the next run end tries again. At most one
    generation runs per session. The in-flight set is in memory, so a restart simply waits for the
    next run end.
  - The call's tokens are charged like Auto Review: the budget and usage measures accumulate along
    the chain, and `context_tokens` is not written.
- A manual title change through `PATCH /api/sessions/:id { title }` clears `title_pending`. Changing
  the title to an empty string also clears it: the session shows the default name and never
  generates one again.

## Subagents

A subagent is an independent session. Every subagent has its own rule set, quota and run state, and
hangs below its parent in the actor chain (`sessions.parent_session_id`). Because every level of the
chain is evaluated and a lower level can only tighten, a subagent can never exceed its parent's
permissions. The parent chooses the child's rules and quota at creation.

- **Rules and quota.** The child receives a complete non-root rule set. The parent can add rules to
  narrow the child's access. It can also give the child a token quota to prevent a loop or an empty
  run; the amount is not capped by the parent's own remaining quota, because every response is
  already charged along the whole chain.
- **Depth.** Subagents nest at most two levels below a root: a child and a grandchild. A conversation
  at the limit is not offered the `subagent` tool; startup applies the same filter to existing
  sessions at the limit.
- **Ownerless conversation.** A child owned by the foreground tool call would end with that call,
  so the child conversation is ownerless: ending a foreground wait does not end the child.
  `AgentRuntime.abort` walks the `parent_session_id` subtree and aborts each conversation
  explicitly, cancels its tasks and ends its waits.
- **Creation.** `subagent(task, rules?, quota?, model?, background?)` creates the child. The child
  session id is derived from the tool task id and the child conversation is linked in the same
  durable commit, so a replay after a restart finds the existing child instead of creating another.
  Without a model, the child inherits the parent's provider and model, and the parent's thinking
  level is clamped to the child's model.
- **Title.** The child's title is the beginning of its task and `title_pending` is false.
- **Tools.** The parent controls children with `subagent_wait`, `subagent_list`, `subagent_cancel`
  and `subagent_decide`. `subagent_decide(request_id, "approve" | "deny" | "escalate", reason?,
  tokens?)` also grants quota with `tokens`.
- **Replay.** The `subagent` tool declares `replay: "safe"`. After a restart it reattaches to the
  same child and submission; `subagent_wait` finds the submission through
  `sessions.last_submission_id`.
- **End of a run.** A child's run end sets it to `idle` whatever the cause (completion, rejection or
  abort); the transcript says what happened. Only a new input sets it back to `running`. The state
  rules are in [Session state](#session-state).

### Session state

Root sessions and subagents share one persisted run state, `sessions.state`:

| State | Meaning | Entered by | Left by |
|---|---|---|---|
| `idle` | No run in progress | Creation; the latest input's run ending (completion, rejection or abort) | A new input → `running` |
| `running` | A run is in progress | An input write; a wait ending | The run ending → `idle`; a tool call starting to wait → `awaiting` |
| `awaiting` | The run is blocked on someone else's decision | A quota pause (`waiting_kind = quota`, `waiting_level_id` names the level); the session's own tool waiting for approval (`approval`) or a signature (`authorization`) | A decision → `running`; a rejection or abort → `idle` |

The state is a stored column, so the session list can filter and order by it in SQL without reading
durable for every row.

- `waiting_kind` has a value only while the session is `awaiting`. Every quota decision reads
  `waiting_kind = quota` rather than only `state = awaiting`. When several waits exist at once,
  quota outranks approval, which outranks signature; ending one wait recomputes the state from the
  others.
- Manual compaction is a run of its own. On an idle session it sets `running`; when the compaction
  task ends and its summary is placed (or the task is stopped), the session returns to `idle`. The
  update is conditional on `state` and `last_submission_id` still being the values that were read,
  so a new input or a stop that lands in between wins. A session that is already running is left
  alone and ends with that run. If crhs restarts during the compaction, startup reconciliation sets
  the row to `idle` while the compaction continues in durable.
- Approval and signature waits are driven by Cluster task state. When a task started by the session
  enters `awaiting_approval` or `awaiting_authorization`, the session becomes `awaiting`; when the
  task leaves that state and no other wait remains, the session returns to `running`. Only a task
  that has a handler counts: an `awaiting_approval` row without `handler_type` is the instant before
  dispatch, not an approval wait (see
  [State machine](execution.md#state-machine)).
- State recomputation is serialized and coalesced per session. A request that arrives while one
  recomputation runs marks the session dirty; the running one recomputes once more after it
  finishes, from the latest data. This keeps the last write current when a privileged task's
  "enter signature wait → crhs signs → leave" produces two recomputations that could otherwise land
  out of order.
- `root_session_id` points at the root of the session tree. The WebUI's session list aggregates
  state over the tree, and any state change in the tree publishes the root (see
  [Session list API](webui.md#session-list-api)).
- **Startup reconciliation.** After durable has resumed runs and before crhs accepts requests, every
  cached state is corrected:
  - a session recorded as `running` or `awaiting` whose latest input has already settled becomes
    `idle`;
  - a session with an unsettled input is recomputed as `awaiting` for a quota or task wait, otherwise
    `running`;
  - a session recorded as `idle` whose latest input is still unsettled becomes `running`.

  Each correction is logged, not audited. The write is conditional on the row that was read, so a
  resumed run's own state write wins instead of being overwritten.
- **Waits nobody will handle.** When a session stops or its run ends, an approval or signature wait
  it left behind has no tool call waiting for it and must be ended.
  - **Stopping a session** (including its subtree): approval waits are rejected, signature waits are
    cancelled, and dispatched or running tasks are cancelled. The reason is `the session was
    stopped`. A run that ends during the stop is not handled a second time through the run-end path.
  - **Run end:** a tool call may be gone (aborted by durable or abandoned after a restart) while its
    task still waits. The wait is ended with the reason `the session's run ended`.
  - **At startup**, after state reconciliation, tasks and task groups that act for a session, whose
    session is already `idle`, and that are still `awaiting_approval` or `awaiting_authorization` are
    ended the same way. This includes a member of a running task group that waits for a signature.
    Only waiting rows are read.
  - **After the Harness reopens**, a failed Harness has dropped all waits. The runtime runs the same
    state reconciliation and then ends the orphaned waits exactly as at startup.
  - Tasks that belong to no session (started by a user or an API token) are not touched; their
    signature waits end only at the 24-hour deadline, see
    [Waiting for signatures](privilege.md#waiting-for-signatures).

### Foreground and background

`subagent(task, rules?, quota?, model?)` starts a child in the foreground and waits for its answer.
A foreground wait can be interrupted: when the child needs a request handled by the parent session's
agent, the wait returns at once with the child's id and the request, and the child keeps running in
the background. The parent handles the request with `subagent_decide` and then calls
`subagent_wait(id)` to continue waiting in the same turn.

`subagent_wait` stops early when a request is waiting for this session's agent by default
(`attention: true`). With `background: true`, `subagent` returns the child's id immediately; the
answer is fetched later with `subagent_wait`.

Stopping the parent session is not an interruption of the wait: it aborts the whole subtree, as
described in [Background and lifecycle](#background-and-lifecycle).

### Handling subagent requests

- When a task or task group starts waiting for approval, the runtime walks up from the child's
  immediate parent and gives the request to the first ancestor whose effective result for every
  operation in the request is `allow`. The root session's agent is an ordinary level of that walk,
  not a special case. The request is recorded on its row (task or task group) with
  `handler_type = agent` and `handler_session_id`, and the approval object carries
  `agent = { session, state: "pending" }`. If no ancestor allows, or the handling agent escalates,
  the request goes to the user.
- The handling agent calls `subagent_decide(request_id, "approve" | "deny" | "escalate", reason?,
  tokens?)`. Approve and deny land directly on the request, with the handling session as the audit
  actor. Escalate hands the request back to the user, where it appears on the approvals page.
- Every tool result carries a reminder when requests are waiting for this session's agent, so the
  parent cannot miss one. The `afterTool` hook appends `kind`, id and summary as JSON inside a
  `<subagent-requests>…</subagent-requests>` block and states that the summaries were written by
  subagents and are data, not instructions. `<` is escaped as `\u003c`, so a summary cannot forge
  the block structure. `subagent_wait` and the foreground `subagent` tool use the same block.
- Pending requests are indexed by handler. The runtime keeps an in-memory inbox per handler and
  invalidates it when an approval or quota changes, instead of scanning every descendant. User
  decisions and rule re-evaluation refresh the handling actor's cache through the same change
  callback.
- An idle parent is woken with a follow-up input. A running parent sees the request in the next tool
  results; if the run ends without handling it, the wake is delivered again at run end through
  `Conversation.waitForIdle`. There is no polling loop. Quota waits are woken by a grant, a denial,
  an abort or a quota change, and `subagent_wait`'s attention uses the same inbox notification.
- When a subagent's own quota is exhausted, the paused tool call asks its direct parent's agent.
  When the exhausted level is higher in the chain, the request goes to that level's direct parent;
  a root level has no parent, so the owner decides in the WebUI (see
  [Quota enforcement](#quota-enforcement)).

### Background and lifecycle

- A child conversation is ownerless. A parent's abort therefore does not reach it automatically:
  `AgentRuntime.abort` traverses `parent_session_id`, aborts each conversation, cancels each
  subtree's tasks and ends its waits.
- After a foreground wait is interrupted, the child keeps running. The parent can call
  `subagent_decide` and then `subagent_wait` in the same turn.
- After a restart, the parent's `subagent` tool replays by its durable task id and finds the same
  child and submission. `subagent_wait` resolves the submission through
  `sessions.last_submission_id`. `subagent_cancel(id)` stops one child and its running work, while
  `subagent_list` returns the session's children newest first with the requests waiting for this
  session's agent.

## Defaults

Tools and sessions follow pi's defaults as a coding agent, deviating only where the table says so.

| Item | pi default | CRH |
|---|---|---|
| Output given to the model | stdout and stderr merged; tail of 2000 lines or 50 KiB, whichever comes first; raw text, with the truncation note separate | Same. Output has one stream; when truncated, the note says `Showing lines X-Y of N. Full output: <path>` |
| Complete output on disk | When the thresholds are exceeded, a file under the system temporary directory (`pi-bash-*.log`, 0600), never cleaned up | Same thresholds, but a crha node writes to the configured output directory under `<state_dir>/output/` (`[output].dir`; the example layout is `/var/lib/crha/output/`, 0600), cleaned after 7 days or 1 GiB. Every crha node of a task group keeps its complete output file whatever the group's output mode, including `status`; an SSH node has no complete output file |
| Command timeout | None by default | Same; `timeout` is optional. `wait` (default 10 minutes for an agent, 30 seconds for MCP) only decides when the tool returns and does not stop the task |
| Read a file | First 2000 lines or 50 KiB, paged with `offset` and `limit` in lines | Same, with node-side line paging: a page starts at `offset`, reads `limit` lines and is at most 50 KiB. The page bytes are returned as they are in the file; a truncated page ends with `Use offset=<n> to continue.` The total line count is reported only at end of file. A first line larger than 50 KiB is an error that points to `exec`; a start line past the end is an error that gives the total |
| List a directory | 500 entries or 50 KiB | 500 entries by default (`limit` 0; maximum 5000) or 32 KiB of entry fields, after which `truncated` says entries were left out |
| grep / find | 100 matches (500 characters per line) / 1000 results | No dedicated tool; use `exec` |
| Automatic compaction | `reserveTokens` 16384, `keepRecentTokens` 20000 | Same; background compaction starts 32768 tokens below the blocking threshold |
| Model request retry | 3 retries, base delay 2 seconds, server-requested wait at most 60 seconds | Same |

The spill threshold equals the model's truncation threshold, so whenever the model sees a
truncation note, the complete output already exists on the node.

`node_info` truncates node notes to 8 KiB, because every call returns them; pi has no equivalent.
The corresponding testing and performance material is in
[Agent runtime tests](testing/server.md#agent-runtime-tests) and
[Server performance](testing/server.md#server-performance).

## Quota and token accounting

A quota is a session budget, not a rule. It is a management limit on how much work a session may do:
it stops loops, empty runs and unattended runs that get out of hand. A scheduled run needs an
unattended cap, and reusing the same pause-and-decide flow avoids a second budget mechanism.
`sessions.quota_tokens` is a signed 64-bit number of remaining tokens. `null` means unlimited, and
an unlimited level is never charged.

- Any level of a session chain may have a quota. A user-created root has none by default, a scheduled
  run's session has `token_budget` on its root (see [Rules and quotas](scheduling.md#rules-and-quotas)),
  and a subagent's parent gives it one at creation.
- A quota can be set as `budgetRemaining` when a session is created or by the owner through
  `PATCH /api/sessions/:id { budgetRemaining }`, which replaces the remaining amount (including on a
  root; `null` removes the limit).
- Only tokens are counted. There is no monetary cost and no user-level or organization-level quota.
- Every model call is charged after it completes, because durable has no interception point before a
  request. The call's output tokens are charged to the budget measure at every level of the chain,
  and **every level that has a quota** has its remaining quota reduced, the root included. The
  usage and prompt/cache measures also accumulate at every level, so a root shows its whole tree.
  Charging after the response rather than aborting in flight does not depend on the timing of an
  asynchronous abort.

### Quota enforcement

- Every level with a quota must remain above zero. A response may take a balance to zero or below:
  the overspend is allowed so that one call is always accounted exactly, and the negative value
  records it. The next tool call checks the chain.
- When any level is at or below zero, the next tool call pauses instead of running. The session
  becomes `awaiting` with `waiting_kind = quota` and `waiting_level_id` naming the exhausted level,
  and the request is reported only to that level's **direct parent**. No level is skipped:
  - when the exhausted level is a subagent, its direct parent session's agent decides. It calls
    `subagent_decide(request_id, "approve", tokens: N)` to add N tokens, or `deny` to stop the
    paused run. The addition is additive and is not capped by the parent's own remainder, because
    the whole chain is charged for every response anyway. When the parent is the root, the root
    session's agent decides.
  - when the exhausted level is the root, the session owner decides in the WebUI, on the approvals
    page's quota item or on the session page. The owner adds N tokens or denies the run; the audit
    actor is the user.
- On a denial the paused tool call ends immediately (the tool result says that the quota is used up
  and the run ends there), the run finishes, and the session returns to `idle`. A read or a
  recomputation never turns it back into `awaiting`. Each new exhaustion is a new pause and notifies
  the handler again.
- The WebUI shows the remaining budget, the context percentage and total usage in the composer
  footer, and the approvals page's quota list uses `budgetRemaining` and `budgetUsedTokens`.

### Token measures

Three measures are stored separately, and their names are not interchangeable: one number cannot be
both the quota measure and the total cost, and the context fill must not be rewritten by a compaction
or a review.

| Measure | Column and API field | What it counts | What it is for |
|---|---|---|---|
| Budget used | `sessions.budget_used_tokens`, `budgetUsedTokens` | Output tokens only (reasoning included) of every model call charged to the session and its descendants: main responses, compaction, Auto Review and title generation | Deciding when a quota pauses a run. Output-only means the measure does not drift with input length or cache hits |
| Usage | `sessions.usage_tokens`, `usageTokens` | Input **and** output tokens of every model call charged to the session and its descendants; input includes cache read and cache write | The total usage figure. It accumulates along the chain, so a root shows its whole tree |
| Context fill | `sessions.context_tokens`, `contextTokens` | The input size (input + cache read + cache write) of the session's **own latest main-agent call**; `null` before the first call | The context percentage against the model's context window. Compaction, Auto Review and title generation do not write it |

The budget and usage measures accumulate at every level of the chain. The context fill belongs only
to the session whose main agent made the call. Budget and usage do not influence each other: the
budget decides when to pause, and usage is display-only and never stops a run.

When the upstream reports no usage, the token measures use one estimate: `ceil(UTF-8 bytes × 0.3)`,
where the constant is `ESTIMATED_TOKENS_PER_BYTE = 0.3` in `server/src/agent/tokens.ts`. The output
estimate covers the text, visible reasoning text, and each tool call's name plus its serialized
arguments. The input estimate covers the JSON of the request actually sent. A generation's
`beforeRequest` sees only the `messages`, so the estimate excludes the system prompt sections and
the tool definitions. Compaction, Auto Review and title generation go through `completeSimple`;
their estimate is the request given to it, the system prompt plus the messages.

A database with no backfill flag is filled once at startup from durable. The runtime reads each
conversation's persisted `pi.usage`, sums input, cache read, cache write and output, accumulates
the tree totals, and raises every counter instead of lowering it. The flag is
`session_stats_backfilled_at` in `server_meta`, written in the same transaction as the values, so
one start either backfills everything or leaves the database untouched for the next start. A call
durable never recorded (Auto Review's or title generation's own request, or a dropped document)
cannot be recovered and stays out of the backfill.

## Session statistics

The generation statistics on a session page describe only the session's **own main-agent calls**.
They are separate from the quota measures.

- **step:** one model call of this session's main agent, that is, each assistant message that lands
  in the session. A call that ended in an error or was aborted still counts when it produced an
  assistant message. Title generation, a compaction summary, Auto Review and a subagent are not this
  session's step; a subagent is a separate session with its own statistics. A retry is a new
  assistant message and therefore a new step.
- **turn:** one user input (submission) that produced at least one step. Retries and later tool
  rounds of the same run do not add a turn. The implementation compares
  `sessions.counted_submission_id` with `last_submission_id` at each step; a different submission
  increments `stat_turns` and records the new id. A subagent's input through `startSubagent` is a
  submission like any other.
- **TTFT and decode time:** timing happens at the provider stream, whether or not anyone is viewing
  the session. The Harness's `Models` is wrapped by `meteredModels` (`server/src/agent/metering.ts`).
  Each generation calls `streamSimple(model, context, options)` and `options.sessionId` is the
  conversation's provider session id. The wrapper records the start S and, as events arrive, the
  first F that carries content (`text_delta`, `thinking_delta`, `toolcall_delta`, or a partial
  start/end that already has content) and the end E at `done` or `error`. All three use the
  monotonic `performance.now()`. At message end, `afterResponse` resolves the CRH session id to its
  provider session id, takes the attempt (taking it also deletes it, and a retry's new call replaces
  the old attempt), and adds `ttft = max(0, F − S)` and `decode = max(0, E − F)`.
  The timing counters are updated only when F and E exist and `usage.output > 0`; otherwise the call
  increments only the step count. The WebUI derives the decode rate from `decodeTokens` and
  `decodeMs`; the rate itself is not stored. Attempts are kept in memory by provider session id,
  are cleared when the message ends, on abort, on session teardown and when the runtime closes, and
  have a hard cap of 1000 entries. Only a main generation starts an attempt; compaction's `completeSimple`
  charges the call but starts no timing, and title generation and Auto Review call
  `ModelConfig.completeSimple` directly, so they never produce an entry that `afterResponse` could
  read. A scheduled run or a background tab is timed the same way.
- **prompt and cache buckets:** `prompt_tokens` adds the input plus cache read and cache write of
  every call, and `cache_read_tokens` adds only the cache-read part. They cover the same calls as
  `usage_tokens` (the session, its subagents, compaction, Auto Review and title generation) and
  accumulate along the chain, so a root's figures cover its tree. They are display-only and do not
  affect quotas.
- **Write path:** the counters and the two token measures are written by one `chargeCall` statement.
  `stat_*` and `counted_submission_id` use SQL `CASE` expressions that limit them to the session's
  own row, while `prompt_tokens`, `cache_read_tokens` and `usage_tokens` are written at every level
  of the chain. `SessionView.stats` returns `{ turns, steps, ttftMs, ttftSteps, decodeMs,
  decodeTokens, promptTokens, cacheReadTokens }`.
- **Live update:** there is no separate statistics event. After `chargeCall`, the runtime calls
  `sessionList.publishSession`; the list stream sends an `upsert` for the tree's root. The session
  page's `useSessionTreeSync` sees the root upsert, invalidates `GET /sessions/:id` and refetches,
  so the statistics update with the rest of the `SessionView`, like `usageTokens` and
  `contextTokens`.
- **Backfill:** the columns default to 0. The one-time backfill described in
  [Token measures](#token-measures) also fills `prompt_tokens` and `cache_read_tokens` from durable's
  `pi.usage`, `stat_steps` from the number of assistant entries, and `stat_turns` by counting a user
  entry followed by at least one assistant entry before the next user entry. Timing cannot be
  recovered and stays 0. Calls durable never recorded are not in the backfill.

## Node notes

A node note is an ordinary Markdown file **on the node**. People and the model read and write it
directly.

- A crha node sets the path in its `crha.toml` (`notes`). Without a value it is `NOTES.md` under the
  configured `state_dir`; the example layout is `/var/lib/crha/NOTES.md`. The path is reported to
  crhs in the node's `Facts` as `notes_path`. An SSH node has no crha Facts, so it has no notes path
  and `node_info` returns no notes for it.
- `node_info` returns the path and the content, cut at 8 KiB, with a hint to read the whole file with
  `read_file`. A batch shares one budget for the notes, as described in
  [Batch execution](#batch-execution).
- Reading and writing use ordinary `read_file`, `edit_file` and `write_file`; their audit entries
  and rule checks are those of any other file operation. There is no notes-specific tool.
- A person can edit the file directly on the node, or through the same file operations in the WebUI.
- Notes are a prompt-injection path: injected content can be written into a note through the agent
  and affect a later session. The audit log records who made each change, so a change can be traced.

## Prompt injection

Node logs, file contents and command output can be controlled by an attacker and still enter the
model's context. The runtime therefore does not treat the model as a security boundary:

- What may run, and whether it may run with privilege, is decided by the Cluster core's policy, not
  by the model's judgment.
- A session's node scope is a hard limit. Rules, approvals and the privilege checks are enforced
  outside the model, in the Cluster core and on the node.
- High-risk work (privilege, system files, cross-node batches) is subject to the same rules and
  approval path outside the model; the model cannot grant itself an exception.
- Auto Review sees only the operation itself and the minimum context needed to judge it, never the
  conversation or node output. One injected text therefore cannot steer both the executor and its
  reviewer.
- Subagent requests are delivered as JSON inside a tagged block that says the summaries are data,
  not instructions; the escaping in [Handling subagent requests](#handling-subagent-requests) keeps
  a summary from closing the block.

## Dependency versioning

The pi packages are pinned to exact versions in `server/package.json` (no `^`), and an upgrade is a
deliberate change rather than a range update.

An upgrade checks, in order:

1. Read the CHANGELOG for breaking changes, especially the `Storage` interface, the `Models`
   wrapper, task hooks and compaction.
2. Update both storage paths: the arguments and behavior of the official SQLite storage, and the
   `PgStorage` port (schema, migrations and SQL). A storage interface change that compiles can still
   break persistence.
3. Run the official storage conformance suite against both dialects, and the PostgreSQL storage
   benchmark.
4. Run the server test suites, including fault injection, the agent-session end-to-end tests and the
   pi import boundary test.
5. Run the performance regression described in
   [Agent runtime tests](testing/server.md#agent-runtime-tests) and
   [Server performance](testing/server.md#server-performance).

Compaction metering and generation timing depend on durable internals: the runtime wraps the
Harness's `Models` (`streamSimple` and `completeSimple`) to charge compaction and time generations,
and `GenerationTask` hooks (`beforeRequest`, `afterResponse`) supply the boundaries where input is
estimated and a step is counted. A change to those internals can compile while charging the wrong
calls or losing a timing entry, so the metering and session-statistics tests are part of every
upgrade. The same applies to the storage port: the conformance suite, not a type check, is the gate.

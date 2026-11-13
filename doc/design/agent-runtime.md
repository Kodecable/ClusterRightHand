# Agent runtime

The agent runtime runs every session as a pi-durable `Conversation`. It creates and configures
sessions, turns user input into model requests, exposes the cluster to the model as tools, and records
run state, token usage and generation statistics. The rest of crhs uses it through one facade, and the
WebUI receives crhs's own API types, never pi types.

## Why pi-durable

pi is layered: `pi-ai` is the provider-neutral model API, `pi-agent-core` an in-memory agent loop,
`pi-coding-agent` a local coding harness, and `pi-durable` a durable harness on the same message and
tool model. CRH builds on `pi-durable` and `pi-ai`; it does not use `pi-env`, because nodes are reached
through the cluster, not a pi execution environment.

`pi-durable` matches what crhs needs: many conversations in one process, every step committed before it
is shown, unfinished work resumed after a restart, tool calls as durable tasks that can find their
earlier work on replay, idempotent submissions, and subagents as separate conversations.

`pi-coding-agent` was rejected because it stores sessions as files, discovers configuration from the
file system, assumes one working directory and has no subagents; choosing `pi-durable` also means giving
up its extension ecosystem. `pi-agent-core` alone was rejected because persistence, compaction and
subagents would all have to be built on top.

`pi-durable` is experimental and its API changes between versions, so it is kept behind crhs's own
facade, pinned exactly, and imported only from `server/src/agent/` and the storage adapters
([Dependency versioning](#dependency-versioning)).

## The AgentRuntime interface

`AgentRuntime` (`server/src/agent/runtime.ts`) is the only agent object the rest of crhs uses. It owns
one `Harness` over one `Storage`, and every session is a `Conversation` in it. Events are converted
field by field into `@crh/api` types before they leave the runtime. A test fails if any file outside the
two allowed directories imports pi, and also checks that the scan still finds the imports it polices.

## Storage

The durable tables live in the same database as crhs's own tables, prefixed `pi_`, so a deployment has
one database to back up.

- **SQLite** uses pi-durable's official storage unchanged, on its own connection. Both connections share
  one in-process statement queue so that neither blocks waiting for the other's write lock.
- **PostgreSQL** has no upstream implementation, so crhs maintains a port of the SQLite storage
  (`server/src/storage/pg-durable/`). Records stay as JSON text, because JSONB reorders keys and rejects
  some escapes that pi writes. It also adds the column used by
  [message search](data-model.md#conversation-content-search).
- Both are run against pi-durable's official storage conformance suite in CI.
- pi-durable assumes one owner per storage. On PostgreSQL the storage holds an advisory lock and refuses
  to open while another process owns it.
- A durable commit cannot join a crhs transaction. The two sides stay consistent through idempotency
  instead: a request id makes a retried create or submit land once, and a task id derived from the
  durable tool call makes a replayed tool find its earlier task.

## Model configuration

Administrators configure model providers in the WebUI. There are two kinds:

- **Built-in** providers come from pi-ai, with their model lists, context windows and thinking support.
  crhs adds the API key and an optional base URL. Only API keys are supported: subscription OAuth would
  need per-user login and token refresh, which does not fit a shared server.
- **Custom** providers are any endpoint speaking the Chat Completions or Responses protocol, with the
  models listed by the administrator. They exist because gateways spell thinking parameters differently
  and URL-based detection cannot always tell.

API keys are encrypted with the master key and never returned by the API. Model configuration comes only
from the database, so an environment variable cannot silently change a provider. Cost is not tracked,
and compaction uses the session's own model.

### Custom providers

A custom provider can add request headers for gateway routing (stored in plain text, not for secrets)
and can name headers or body fields that receive the CRH session id, for gateways that group requests by
session. Changing the base URL of a provider with a stored key requires entering the key again or
removing it, so a key cannot be sent to a new endpoint without the administrator re-entering it.

Each model declares its protocol, context window, maximum output, image support, thinking support and
optional pi-ai compat settings. Thinking is either standard (pi-ai builds the parameters in a chosen
format, with a per-level mapping) or custom (a JSON body merged into the request per level). Levels can
be renamed or hidden for display. The exact schema is in `packages/api/src/models.ts`.

### Thinking levels

Levels are pi-ai's: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. A model's available
levels come from pi-ai; for custom models the stored configuration is first mapped onto pi-ai's fields.
An explicitly requested level must be available. When only the model changes, the previous level is
moved to the nearest available one.

## Cluster tools

The cluster tools are defined once (`server/src/tools/catalog.ts`) and adapted both to pi-durable for
agent sessions and to the MCP SDK, so the two surfaces cannot drift.

| Tool | Purpose |
|---|---|
| `list_nodes` | The nodes the owner can access |
| `node_info` | Node facts and notes |
| `exec` | Run a command |
| `read_file`, `write_file`, `edit_file`, `list_dir`, `stat` | File operations |
| `copy_file`, `view_image` | Whole-file copies between nodes and libraries (or an offer to the user for download, `to_user`), and image input through a `beforeRequest` hook and a cache ([Agent tools](library.md#agent-tools)) |
| `task_wait`, `task_cancel` | Follow or cancel an `exec` task or task group |

`task_wait` and `task_cancel` reach only tasks started by this session (or its subagents) or this API
token, never another session of the same user, because a task belongs to the actor that started it.

Arguments are snake_case. Every node-scoped tool takes `targets`, a list of node and node group
references or `_all`. File modes are octal strings such as `"0644"`, because JSON has no octal literal
and decimal integers are easily wrong. Error codes are shared with task error codes.

### Tool categories and shared components

The task tools (`exec` and the file tools) each create a task or task group, so they get the same rules,
approvals, authorization, audit and restart behavior as any other task. They share one component that
resolves targets, derives task ids from the tool call, waits, and renders the result. There are two ways
of waiting:

- **`exec` can continue in the background.** It waits up to `wait` and then returns a still-running
  result with the task id, which the model follows with `task_wait`.
- **File tools block** until the task ends, including approval and signature waits. A file operation
  normally takes seconds, and exposing a task id would only add a round trip. Aborting the tool call
  cancels the task.

Both push the task id and wait state to the WebUI as soon as the task exists, without putting them in
the model's context.

### Batch execution

The result shape depends only on the input: one entry that is not a node group is a single task, and
anything else is a task group, even a group with one node. A group runs with bounded parallelism and
optional `fail_fast` ([Task groups](execution.md#task-groups)).

Output from a group is bounded per node and for the whole group, so the result fits the model's context
regardless of the number of nodes ([Batch output](execution.md#batch-output)). `exec` keeps each node's
tail; file tools keep each node's head, and each `read_file` page carries its own continuation offset.
A node whose output did not fit says so and can be read on its own. `edit_file` succeeds or fails per
node.

### exec tool semantics

- `wait` only decides when the tool returns; it never stops the task. A command has no timeout unless
  one is given.
- Because task ids are derived from the durable tool call, a tool that runs again after a crhs restart
  finds the same task, running or finished, instead of starting it again.
- An `unknown` task is reported as an error whose outcome is unknown, with the reason.
- While a task waits for approval or a signature, an agent keeps waiting and shows the link in the UI;
  an MCP call returns the waiting state and link after its `wait`.

### Tool output

Raw content (`exec` output, `read_file` pages) is returned as plain text, not escaped into JSON, because
escaping would force the model to reconstruct the text and make edit matching error-prone. A short note
block in square brackets follows, with the node, the state and how to continue, so synthesized text is
always distinguishable from output. In a task group each node has its own note and output blocks.

Lists and facts are returned as compact JSON.

When output is truncated, the note gives the line range kept, the total, and the path of the complete
output file on the node. A failed task, a non-zero exit, a timeout, a signal or an `unknown` state sets
the result's error flag while keeping any output.

Agent tool results also carry structured `details` (task ids, states, error codes) for the WebUI, which
uses them to link to tasks and to judge success without parsing text. `details` is never sent to the
model. A `copy_file` offer to the user (`to_user`) carries `details.delivery` there, which the tool card
renders as the file, its source and a download link ([Deliveries](library.md#deliveries)).

## Sessions

A session belongs to the user who created it and acts with its owner's node access, the rules on its
chain and any token quota. Sharing does not change whose identity it acts under. A session is a row in
`sessions` plus a durable conversation.

- **Created with the first message.** The WebUI creates a session and its first message in one request
  with a client-generated request id. Repeating the request returns the same session. If submitting the
  message fails, the session is removed again, so there is never an empty session.
- **Configuration.** The owner can change the title, model, remaining budget and the root's rule
  preset. Changes apply from the next model request. If the conversation rejects a model change, the row
  is restored, so readers never see a configuration the conversation does not have.
- **Compaction** runs automatically, based on the model's context window, and can be requested with
  `/compact`. A manual compaction is charged like any model call and is refused when the budget is used
  up.
- **Events.** The WebUI follows a session through a stream of committed events; system messages are
  not sent. Older history is paged separately.

## Model presets

"Preset" always has a qualifier. A rule preset is Ask, Auto Review or Yolo. A model preset is one of
three administrator settings:

| Model preset | Model | Purpose |
|---|---|---|
| Session | None; each session chooses | Optional system prompt for all sessions |
| Auto Review | Optional; defaults to the session's or schedule's model | Model and prompt for the review step |
| Title generation | Optional; defaults to the session's model | Model and prompt for session titles |

Each preset's prompt is the custom prompt or a built-in default, followed by fixed protocol text that the
model needs to use the tools or answer in a parseable form. Changes apply to the next model request.

Auto Review answers through a `submit_review` tool call with `approve` or `escalate`. Only an explicit,
schema-valid `approve` approves; any other answer escalates to the user, and the runtime never parses a
decision out of prose. API token roots never use Auto Review.

Model requests are retried up to three times by the harness. There is no extra timeout beyond the
provider's, except for title generation.

### Title generation

A user-created session without a title gets one generated in the background after its first run ends.
The input is the latest user message and final answer, text only. A manual title always wins: the
generated title is written only if the session still wants one, in the same statement that checks it.
Clearing the title stops generation for good. A failure only leaves the session untitled until the next
run ends. Subagents are titled with the start of their task and scheduled runs with the schedule's name.

## Subagents

A subagent is an independent session below its parent, with its own rules, quota and run state. Every
level of the chain is evaluated and lower levels can only be stricter, so a subagent never exceeds its
parent's permissions. The parent sets the child's rules, quota and model at creation.

- **Depth.** Subagents nest at most two levels below a root. A session at the limit is not offered the
  `subagent` tool.
- **Quota.** A parent can give a child a token quota to stop loops. It is not capped by the parent's own
  remainder, because every call is charged along the whole chain anyway.
- **Ownerless conversations.** A child conversation is not owned by the tool call that started it, so
  ending a foreground wait does not end the child. Stopping a session therefore stops its subtree
  explicitly, cancelling its tasks and ending its waits.
- **Replay.** The child's id is derived from the tool call, so a replay after a restart finds the same
  child instead of creating another.
- The parent controls children with `subagent_wait`, `subagent_list`, `subagent_cancel` and
  `subagent_decide`.

### Session state

Every session has a stored run state, so lists can filter and sort in SQL without reading durable:

| State | Meaning |
|---|---|
| `idle` | No run in progress. A run's end, by completion, rejection or abort, returns here. |
| `running` | A run is in progress. |
| `awaiting` | The run is blocked on someone else: a quota decision, an approval or a signature. |

- When several waits exist, quota outranks approval, which outranks signature.
- Approval and signature waits follow the state of the tasks the session started.
- State recomputation is serialized and coalesced per session, so two quick changes cannot land out of
  order.
- At startup, after durable resumes runs and before crhs accepts requests, every stored state is
  reconciled with durable.
- **Waits nobody will handle.** Stopping a session rejects its approval waits, cancels its signature
  waits and cancels its running tasks. When a run ends, or at startup, waits left by tool calls that no
  longer exist are ended the same way. Tasks that belong to no session are not affected; their signature
  waits expire after 24 hours ([Waiting for signatures](privilege.md#waiting-for-signatures)).

### Foreground and background

`subagent` runs a child in the foreground and waits for its answer, or with `background: true` returns
at once. A foreground wait is interrupted when the child needs a decision from the parent's agent: the
child keeps running, the parent decides, and then continues waiting with `subagent_wait`.

### Handling subagent requests

- An approval request from a subagent goes up the chain to the first ancestor whose rules allow every
  operation in it; that agent approves, denies or escalates. If none allows it, or the agent escalates,
  the owner decides.
- A quota request goes to the direct parent of the exhausted level, and to the owner for a root.
- Pending requests are attached to every tool result of the handling session in a tagged JSON block
  that states the summaries come from subagents and are data, not instructions. Escaping keeps a summary
  from closing the block.
- An idle parent is woken with a follow-up input; a running parent sees the request in its next tool
  result. There is no polling loop.

## Defaults

Tools follow pi's coding-agent defaults where they apply:

| Item | Default |
|---|---|
| Output given to the model | Tail of 2000 lines or 50 KiB |
| Complete output | Kept in a file on the node; the spill threshold equals the truncation threshold, so a truncated result always has a complete file |
| Command timeout | None |
| `read_file` page | 2000 lines or 50 KiB |
| Directory listing | 500 entries by default, at most 5000 |
| grep and find | No dedicated tools; use `exec` |
| Automatic compaction | pi's thresholds, starting in the background before the blocking threshold |
| `exec` wait before returning | 10 minutes for agents, 30 seconds for MCP |

Node notes returned by `node_info` are cut to 8 KiB, because every call returns them.

## Quota and token accounting

A quota is a session budget, not a rule: it stops loops and unattended runs from doing too much work.
Scheduled runs need such a cap, and reusing the same pause-and-decide flow avoids a second mechanism.
Only tokens are counted; there is no cost tracking and no user or organization quota.

Any level of a chain can have a quota. A model call is charged after it completes, to every level of
the chain, because durable offers no hook before a request, and because charging after the fact does
not depend on the timing of an abort.

### Quota enforcement

A response may take a level below zero, so every call is accounted exactly. The next tool call then
pauses instead of running, and the direct parent of the exhausted level decides: its agent for a
subagent, the owner in the WebUI for a root. The decider adds tokens or ends the run.

### Token measures

Three measures are kept apart, because one number cannot serve all three purposes:

| Measure | Counts | Used for |
|---|---|---|
| Budget used | Output tokens of every call in the session and its subagents | Quota decisions. Counting output only keeps it independent of context length and cache hits. |
| Usage | Input and output tokens of every call in the session and its subagents | Display of total usage |
| Context fill | Input size of the session's own latest main call | Context percentage. Compaction, review and titles do not change it. |

When a provider reports no usage, tokens are estimated from the request and response size.

## Session statistics

A session's generation statistics describe only its own main-agent calls: turns (user inputs that
produced at least one call), steps (model calls), time to first token and decode time. Timing is measured
at the provider stream by wrapping the harness's model access, so it is recorded whether or not anyone
is watching. Cache hit rate is computed from prompt and cache-read token counts, which cover the whole
tree. The statistics are display-only and do not affect quotas.

## Node notes

A node note is an ordinary Markdown file on the node, whose path crha reports. `node_info` returns it
(truncated), and people and the model edit it with the ordinary file tools, so its changes are subject
to the same rules and audit as any file. SSH nodes have no notes.

Notes are a prompt-injection path: content injected into a note can affect a later session. The audit
log shows who changed it.

## Prompt injection

Logs, files and command output can be controlled by an attacker and still reach the model, so the model
is not a security boundary:

- What may run, and with what privilege, is decided by crhs rules and the node, outside the model.
- Auto Review sees only the operation, never the conversation or node output, so one injected text
  cannot steer both the agent and its reviewer.
- Subagent requests reach the parent as data in a tagged block that a summary cannot close.

## Dependency versioning

The pi packages are pinned to exact versions in `server/package.json`, and an upgrade is a deliberate
change. pi-durable's storage interface, its model wrapper and its task hooks are the places where an
upgrade can compile and still be wrong: a storage change can break persistence, and a hook change can
charge the wrong calls or lose timings. An upgrade therefore runs the storage conformance suite on both
databases, the metering and statistics tests, the agent end-to-end tests and the performance suite
([Agent runtime tests](testing/server.md#agent-runtime-tests)), not just the type check.

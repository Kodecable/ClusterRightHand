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
and can name headers or body fields that receive a session id, which some upstreams require (OpenCode) or
recommend (OpenRouter) for prompt caching and session affinity. Changing the base URL of a provider with a stored key requires entering the key again or
removing it, so a key cannot be sent to a new endpoint without the administrator re-entering it.

Each request stream of a session has its own provider session id: the main conversation keeps durable's
provider session id, and compaction, Auto Review and title generation derive a deterministic UUIDv5 from
the crh session id and their purpose. The custom session id fields therefore carry a different value for
the four streams — the main stream's crh session id, or the derived id itself when the value is not a
session in the map. Upstreams use this id for cache keys and affinity, so requests whose prompts have
completely different prefixes (a summarization prompt, a review, a title) must not share the main
conversation's cache identity. A derived id is stable across calls and restarts. A compaction whose
conversation is not mapped yet derives from durable's provider session id instead, never reusing it.

Each model declares its protocol, context window, maximum output, image support, thinking support and
optional pi-ai compat settings. Thinking is either standard (pi-ai builds the parameters in a chosen
format, with a per-level mapping) or custom (a JSON body merged into the request per level). Levels can
be renamed or hidden for display. The exact schema is in `packages/api/src/models.ts`.

### Model discovery

A custom provider can list its models behind **List provider models** in the WebUI. crhs makes the
provider's `GET {baseUrl}/models` request itself, with the stored API key as `Authorization: Bearer` and
the provider's extra request headers, and returns only the `data[].id` values; the key never reaches the
browser. The request times out after 15 s, and an HTTP error, a timeout, a non-JSON body or a body without a
usable `data` list is answered as a 502 whose message the dialog shows. Discovery reads the saved provider,
so an unsaved base URL or key must be saved first. A custom provider may be saved without models for
this; the WebUI then keeps the dialog open on the saved provider, ready to list its models.

The catalogue behind the fill is models.dev's `api.json`. Before each list request crhs may refresh it into
`models-dev/api.json` under its data directory — the directory of the SQLite database, or of the master key
file with PostgreSQL — at most once every 24 hours. Concurrent requests share one download (single
flight), the download times out after 10 s, and the body is written to a temporary file and renamed only
after it parses and holds at least one provider with one model. A failed download is logged once per
attempt and keeps the last good file, however old it is. When no good file was ever stored, pi-ai's bundled
catalogue is used, which is generated from models.dev. `[models] catalog_download = false` in `crhs.toml`
turns the download off: the stored file is still used when there is one, and otherwise the bundled
catalogue. The download is a plain GET; no model ids are ever sent to models.dev.

Saving the selection adds every chosen model with the Chat Completions protocol (`openai-completions`).
Each field is filled from the catalogue: a provider whose API URL has the same host as the custom
provider's base URL and has the exact model id wins; otherwise any provider with the exact id; when neither
matches, both lookups are retried with the part after the id's last `/` (`deepseek/deepseek-v4-flash` →
`deepseek-v4-flash`). With several matches the minimum context and output are used, image input is set only
when every match lists `image` in `modalities.input`, reasoning only when every match has `reasoning: true`,
and the thinking level map holds only the effort levels every match offers. A model's `name` comes from the
first match in provider/id order when the catalogue has one. When nothing matches, the model gets
`contextWindow` 32768, `maxTokens` 4096, text input, no name and no thinking configuration. A match without a
usable context or output falls back to those defaults, a missing or zero catalogue output falls back to
`min(contextWindow, 4096)`, and an output larger than the context is capped at it.

A reasoning model gets a standard thinking configuration without a format, so pi-ai decides the parameters
from the base URL. Its level map maps the catalogue's `reasoning_options` effort values (`minimal`, `low`,
`medium`, `high`, `xhigh`, `max`) onto the same pi-ai levels; a `toggle`-only option, or no effort values,
uses the manual model dialog's default empty map. A model the catalogue marks as not reasoning gets no
thinking configuration. Every added model can be edited afterwards in the model dialog, and the add is
audited like any other provider edit.

### Thinking levels

Levels are pi-ai's: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. A model's available
levels come from pi-ai; for custom models the stored configuration is first mapped onto pi-ai's fields.
An explicitly requested level must be available. When only the model changes, the previous level is
moved to the nearest available one. A level's display name is never translated: a custom model's own
display name when it defines one, otherwise the raw level id (`high`). The WebUI, the user settings and
the chat commands all show that name.

## Cluster tools

The cluster tools are defined once (`server/src/tools/catalog.ts`) and adapted both to pi-durable for
agent sessions and to the MCP SDK, so the two surfaces cannot drift.

| Tool | Purpose |
|---|---|
| `list_nodes` | The nodes the owner can access |
| `node_info` | Node facts and notes |
| `exec` | Run a command |
| `read_file`, `write_file`, `edit_file`, `list_dir`, `stat` | File operations |
| `copy_file`, `view_image` | Whole-file copies between nodes and libraries (or an offer to the people in the session, `destination.user_interface`), and image input through a `beforeRequest` hook and a cache ([Agent tools](library.md#agent-tools)) |
| `job_wait`, `job_cancel`, `job_list` | Follow, cancel or list the jobs these tools start ([Jobs](jobs.md)) |
| `pty_open`, `pty_list`, `pty_read`, `pty_watch`, `pty_write`, `pty_resize`, `pty_close` | [Terminals](pty.md#agent-tools) the session created or is associated with; agent sessions only, while the subsystem is on. `pty_open` and `pty_write`/`pty_resize` follow the session's rules under `pty.create` and `pty.io`; a waiting rule approval is shown on the terminal page and in its session's decision dock, a privileged open's signature wait in the same dock, and Auto Review sees the screen |
| `todo_write` | A root session's todo list, replaced whole; attached to its compaction summary ([Todo list](todo.md)) |
| `search_tools`, `call_tool` | Find and call an extension's tools, MCP or built-in ([Extensions](extensions.md)) |
| `ext__<extension>__<tool>` | A "list directly" extension's tool, called without `call_tool` |
| `search_docs`, `read_doc` | The built-in `crhs-docs` extension: search this version's documentation and API reference, and read a document or a section of it |
| `api_request` | The built-in `crhs-api` extension: one crhs API request as the session owner, through the same routes and rules as the WebUI |

`call_tool`, the directly listed `ext__<extension>__<tool>` tools and `api_request` take `wait` like
`exec`: a call that settles in time returns its result, otherwise the tool returns a waiting or
still-running note with the job id and the call goes on in crhs's runner
([Background extension calls](jobs.md#background-extension-calls)). Ending the tool invocation only
stops waiting.

Those rows are extension tools, not cluster tools: the tool list grows with the "list directly" flag and
the built-in extensions, while `search_tools` and `call_tool` stay fixed ([Tools for the model](extensions.md#tools-for-the-model)).

The job tools reach only jobs started by this session (or its subagents) or this API token, never
another session of the same user, because a job belongs to the actor that started it
([Ownership](jobs.md#ownership)).

`todo_write` is offered to root sessions only. A subagent works on one delegated task, whose plan is its
parent's, so a subagent conversation does not get the tool and a call without a root session is refused.
MCP clients do not get it either: a client keeps its own plan ([Scope](todo.md#scope)).

Arguments are snake_case. Every node-scoped tool takes `targets`, a list of node and node group
references or `_all`. File modes are octal strings such as `"0644"`, because JSON has no octal literal
and decimal integers are easily wrong. Error codes are shared with task error codes.

### Tool categories and shared components

The task tools (`exec` and the file tools) each create a task or task group, so they get the same rules,
approvals, authorization, audit and restart behavior as any other task. They share one component that
resolves targets, derives task ids from the tool call, waits, and renders the result. There are two ways
of waiting:

- **`exec` can continue in the background.** It waits up to `wait` and then returns a still-running or
  waiting result with the job id, which the model follows with `job_wait`. Each `exec` call creates an
  `exec` job over its task or task group ([Jobs](jobs.md)).
- **File tools block** until the task ends, including approval and signature waits. A file operation
  normally takes seconds, and exposing a task id would only add a round trip. Aborting the tool call
  cancels the task.

Both record the task's details and wait state for the WebUI as soon as the task exists; the model sees
a job id instead of the task id.

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
- Because tasks, task groups and jobs are derived from the durable tool call, a tool that runs again
  after a crhs restart finds the same task and job, running or finished, instead of starting it again.
- The model sees the job id, never the underlying task or task group id; those stay in the tool result's
  details for the WebUI.
- An `unknown` task is reported as an error whose outcome is unknown, with a reason-specific message that
  says whether the task may have run. A result the node reported later is recorded on the task and
  appended to that note, while the state and outcome stay unknown.
- `wait` covers approval and signature too, for `exec` as for extension calls: while the work waits for
  a person, the UI shows the link; when `wait` runs out first, the tool returns the waiting state, the
  link and the job id, and the job's completion notice reports the end ([Jobs](jobs.md#completion-notices)).

### Read anchors

`read_file` takes a line offset, and the model keeps thinking in lines: they are what `grep -n`, stack
traces and editors give it, and a byte offset could cut a UTF-8 character. A page deeper in a file would
then read every earlier line again, which costs nothing much on a crha node but costs the network on an
SFTP node and a backend read on a library. So each page records where it ended, and a later page starts
there instead.

- crhs keeps one bounded in-memory store of anchors (`util/read-anchors.ts`): per file, the line where a
  page started and the line after it ended, each with the byte where that line starts, tagged with the
  file's version. At most 64 anchors per file and 1024 files are kept; a restart forgets them all.
- A read takes the anchor with the greatest line not past its offset, if the file's version is the
  same, and starts reading at its byte, counting lines from there. Any mismatch reads from the start. For a
  library file a stale anchor costs a full scan, never a wrong page; for an SFTP file the version check
  has the one gap described below, where a page's line numbers can be off.
- The store is shared by every session and MCP caller. An anchor holds only line and byte numbers, never
  content, so sharing it reveals nothing a caller could not read; and the reader checks it against the
  file, so it does not matter who left it. Keeping anchors in each conversation's transcript was
  rejected: it needs a transcript scan per read, and MCP calls have none.
- The version is:
  - **Library file**: its SHA-256. An object never changes, so the same SHA-256 is the same bytes.
  - **SFTP file**: size and modification time, since SFTP reports no device or inode, plus the SHA-256
    of up to 4 KiB before the anchor, which must end with a newline and is read again before the anchor
    is used. The time has one-second precision and comes from the host's clock, so comparing it with
    crhs's clock cannot tell a change in the same second; such a change that keeps the size is caught
    only if it touches that window. The page's line numbers would then be off, which edits do not
    depend on: `edit_file` matches text.
  - **crha file**: none; crha scans from the start. A local scan is cheap, and an anchor there would
    change the `file.read` spec, which takes a new task kind.
- The anchor is a hint to the executor, not part of the task spec, so the spec hash, approvals and
  authorizations do not see it.

### Tool output

Raw content (`exec` output, `read_file` pages) is returned as plain text, not escaped into JSON, because
escaping would force the model to reconstruct the text and make edit matching error-prone. A short note
block in square brackets follows, with the node, the state and how to continue, so synthesized text is
always distinguishable from output. In a task group each node has its own note and output blocks.

Lists and facts are returned as compact JSON.

When output is truncated, the note gives the line range kept, the total, and the path of the complete
output file on the node. A failed task, a non-zero exit, a timeout, a signal or an `unknown` state sets
the result's error flag while keeping any output. A privileged task's note also names how the node
applied privilege: `privileged via forward` or `privileged via native`, and on an SSH node
`privileged ignored: SSH runs as <user>`, from the notice crhs recorded on the task.

Agent tool results also carry structured `details` (task ids, states, error codes) for the WebUI, which
uses them to link to tasks and to judge success without parsing text. `details` is never sent to the
model. A `copy_file` offer to the people in the session (`destination.user_interface`) carries
`details.delivery` there; after the turn ends, the delivered-file box shows the file, its source and a
download link ([Deliveries](library.md#deliveries)).

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
- **Todo list.** A root session's agent keeps its list through `todo_write`; the row holds it and the
  session stream publishes `todo.changed` ([Todo list](todo.md)). No turn boundary or run end clears it;
  a fork copies it with the conversation. When a compaction is planned, the list at that moment is
  recorded with the session, and every later request appends it to the summary message, so the model
  keeps seeing the plan after the calls that wrote it were summarized
  ([Compaction](todo.md#compaction)).
- **Events.** The WebUI follows a session through a stream of committed events; system messages are
  not sent. Older history is paged separately.

### Forking

The owner can fork a session at the final assistant reply of an ended turn. The result is a new,
independent root session whose history is the source's history up to and including that reply. Nothing
else creates a fork.

- **Durable history.** The fork is pi-durable's `Conversation.fork(at)`: the entries are shared by
  reference, not copied into a new transcript. The new conversation records its parent and cutoff, so
  the fork's history is the source chain through the reply and never a later turn.
- **Identity.** The fork has its own `sessions` row, conversation, id and provider identity. It is a new
  root: `parent_session_id` is null, `root_session_id` is its own id, and `schedule_id`,
  `last_used_from` and every share are absent. `forked_from_session_id` and `forked_from_entry_id` name
  the direct source and reply, so a fork of a fork points at its own source.
- **Provider session ids.** `pi.provider` is a conversation document that forks as `initial`, so the
  fork starts with a fresh durable provider session id. Compaction, Auto Review and title generation
  derive their own ids from the new crh session id (or, before the mapping is known, from the fresh
  provider id), so none of the four request streams reuses the source's cache identity.
- **Rules.** The source root's rule set is copied into a new root rule set: the same preset, custom
  rules and default. The two sets are independent from then on; changing either never changes the
  other.
- **Agent configuration.** The fork takes the source's current model and thinking level, its enabled
  extensions (and therefore its `disabled_extensions` row) and its instructions. The agent document
  durable copies as of the reply is overwritten by that current configuration.
- **Reset state.** A fork starts `idle` with no waits, quota, unread marker, usage, statistics or
  submission counters. The source's shares, approvals, tasks, task groups, external calls and subagent
  sessions are not copied.
- **Title.** The fork's title is the source title plus a localized suffix: ` (fork)` in English,
  `（分叉）` in Chinese; an untitled source falls back to the localized "New session" wording first. A
  source title that already ends with either locale's suffix gets no second one, so a fork of a fork
  keeps its title; otherwise the base is cut (in code points, then trimmed) so the whole title stays
  within the 60-code-point limit below. The title is settled when the row is written, so no generation
  runs for it.
- **Validation and idempotency.** The entry must be a visible entry of the fork's source conversation:
  a completed assistant message without tool calls, the last non-compaction entry of its turn, and a
  turn that has ended (a later user turn exists or the session is idle). Process text, thinking, tool
  results, user entries, other conversations and an unfinished turn are refused. `requestId` makes a
  retried or concurrent request return the first fork, and `session.forked` records the source, the
  reply and the new session.
- **API.** `POST /api/sessions/{id}/fork` with `{ entryId, requestId }` answers `{ session }` for the new
  `SessionView`. Its `forkedFrom` names the source, the reply and the source title as the caller sees it;
  it is null for a session that is not a fork, when the source is gone, or when the caller may no longer
  see it.

## Model presets

"Preset" always has a qualifier. A rule preset is Ask, Auto Review or Yolo. A model preset is one of
three administrator settings:

| Model preset | Model | Purpose |
|---|---|---|
| Session | None; each session chooses | Optional system prompt for all sessions |
| Auto Review | Optional; defaults to the root session's model | Model and prompt for the review step |
| Title generation | Optional; defaults to the session's model | Model and prompt for session titles |

Each preset's prompt is the custom prompt or a built-in default, followed by fixed protocol text that the
model needs to use the tools or answer in a parseable form. A change to the Auto Review or Title
generation preset applies to the next model request; a change to the Session preset applies to sessions
whose prompt is not yet assembled ([Session system prompt](#session-system-prompt)).

### Session system prompt

A session's system prompt is assembled once, at the session's first model request, and stored with the
session (`sessions.system_prompt`); every later request, after a restart too, uses the stored text. It is
assembled in this order:

1. **The prompt**: the Session preset's custom prompt, or the default. The default says that the model is
   a helpful assistant running inside ClusterRightHand Server (crhs), operating the user's nodes for them,
   that it replies in the language of the user's latest message, and that it is concise. A custom prompt
   replaces all of it.
2. **The protocol**: the tool guide, fixed in code. It explains targets, the output notes, job ids,
   libraries, approvals, extensions, subagents and the sent-time note on user messages.
3. **The user**: the session owner's username, display name and user groups (at most 20 named, the rest
   counted), quoted as data, and which libraries they reach.
4. **For a subagent**: that its user messages come from the parent agent, not from a person.
5. **The extension list**: each extension the session can use, with its description and tool count.
6. **The skills**: the owner's [skills](library.md#skills), each with its name and description, sorted by
   name; or, past the limit, one line saying there are too many to list. Nothing when there are none.
7. **The user's instructions**: `AGENTS.md` at the root of the owner's personal library, after the skills,
   quoted in a `<user_instructions>` block with a line saying they are standing instructions that rank below
   the tool guide and the user's messages in the session
   ([AGENTS.md](library.md#agentsmd)). At most 32 KiB: a larger file is not truncated, and the section is one
   line naming the file, its size and how to read it with `read_file`. No personal library, no file and
   empty content leave the section out silently; content that is not valid UTF-8 or holds a NUL byte, and a
   read error, also leave it out but log one warning and do not fail the session's request.

Nothing rewrites a session's prompt afterwards, as in a coding agent: the provider's prompt cache keeps
the prefix, and the model's instructions do not shift under a running conversation. A later change takes
effect the way it does anyway: settings and extension grants through the tool definitions and the tools'
own checks, rules and access through the decisions on each call, a new or changed skill, a changed
`AGENTS.md` or Session preset in sessions started afterwards. A fork and a subagent are sessions of their
own and assemble their own prompt. Compaction does not touch the system prompt either: its summary is a
user message, so the instructions and skills stay in effect after it. The current time is never in it; it
travels with the user messages.

### Message time

Each user message ends with one text block that crhs adds when the message is submitted, such as
`[Sent 2026-11-19 19:30, Thursday, Asia/Shanghai (UTC+08:00), the user's time zone]`: the local date and
time, weekday, IANA time zone and UTC offset, and whose time zone it is. The text is stored with the
message, so later requests send the same bytes and the prompt cache holds.

| Sender | Time zone |
|---|---|
| WebUI (new session and message) | The browser's, sent as `timeZone`; an unknown or missing zone uses the server's |
| API token that sends `timeZone` | That zone, under the same rule |
| Chat channels, API tokens without `timeZone`, MCP | The server's |
| Schedule run | The schedule's own time zone |
| A subagent's task from its parent | The server's |

The typed text stays the message's first text block. The WebUI transcript, a chat's history, title
generation, Auto Review's user instructions and session search read only that block, so nobody sees the
note and it never counts as something the user wrote. A subagent request's wake message to its handler
is not a user message and carries no time.

Auto Review answers through a `submit_review` tool call with a decision and a risk level: `approve` or
`escalate`, and `low`, `medium` or `high`. Only a consistent, schema-valid answer can approve — low+approve,
medium+approve, medium+escalate or high+escalate; a high-risk approval, a missing or invalid risk and any
other answer escalate, and the runtime never parses a decision out of prose
([Auto Review](access-control.md#auto-review)). Reviews run at `temperature: 0`. A configured Auto Review
model preset keeps its own model and thinking level; when the review falls back to the root session's
model it does not inherit that model's conversation thinking level but runs at `low`, clamped to the
nearest level the model supports. API token roots never use Auto Review.

Model requests are retried up to three times by the harness. There is no extra timeout beyond the
provider's for conversation calls. Auto Review and title generation drive `streamSimple` directly and
bound it themselves: an idle limit of 300 seconds (reset on every stream event, thinking deltas
included) and an overall limit of 600 seconds, both aborting the provider request through an
`AbortSignal` (combined with the tool call's or turn's own signal). The limits are in
`server/src/agent/llm-timeout.ts` and are injectable for tests. A review cut by a limit escalates with
the reason "Auto Review timed out"; a title call that fails leaves the session untitled until its next
run ends.

### Title generation

A user-created session without a title gets one generated in the background after its first run ends.
The input is the latest user message and final answer, text only. A manual title always wins: the
generated title is written only if the session still wants one, in the same statement that checks it.
Clearing the title stops generation for good. A failure only leaves the session untitled until the next
run ends. Subagents are titled with the start of their task and scheduled runs with the schedule's name.

A title is at most 60 characters, counted in Unicode code points, not UTF-16 units
(`SESSION_TITLE_MAX_CHARS` in `packages/api`). A generated title is cut to that length; a create or
patch request with a longer one is a 400, and the WebUI's title editor shows a field error and does not
submit it. Fork suffixes count against the same limit, so the base is shortened rather than the title
growing past it.

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
- The parent waits for a child with `job_wait` on the `subagent` job `subagent` returned, and controls
  the tree with `subagent_list` and `subagent_decide`. Stopping a child is `job_cancel` on its job.

### Session state

Every session has a stored run state, so lists can filter and sort in SQL without reading durable:

| State | Meaning |
|---|---|
| `idle` | No run in progress. A run's end, by completion, rejection or abort, returns here. |
| `running` | A run is in progress. |
| `awaiting` | The run is blocked on someone else: a quota decision, an approval or a signature. |

- When several waits exist, quota outranks approval, which outranks signature.
- Approval and signature waits follow the state of the tasks the session started, an external call's
  own row, a terminal rule approval waiting in memory with its terminal and a privileged terminal's
  signature wait ([Terminals](pty.md#approvals)).
- State recomputation is serialized and coalesced per session, so two quick changes cannot land out of
  order.
- At startup, after durable resumes runs and before crhs accepts requests, every stored state is
  reconciled with durable. A terminal approval is memory-only and does not survive a restart, so
  reconciliation never finds one.
- **Reviewing is not waiting.** A task, task group or external call whose Auto Review marker is pending
  is not a wait yet: the session stays `running` while the reviewer decides, so no chat notification or
  approval badge appears. A terminal request is reviewed before it is written as a user-facing wait, so
  it behaves the same way. Only a verdict that sends the request to the user (escalation, failure or a
  timeout) makes the session `awaiting/approval`; the review hook refreshes the state at that point.
  Stopping the session or ending its run still rejects reviewing requests like any other wait.
- **Waits nobody will handle.** Stopping a session ends its approval waits, including a waiting
  terminal rule approval, cancels its signature waits and cancels its running tasks, and stops its
  subtree's jobs ([Jobs](jobs.md#lifecycle-and-retention)).
  When a run ends, or at startup, waits left by tool calls that no longer exist are ended the same way;
  a wait held by a live job is not one of them, because the background work it belongs to still needs it.
  Tasks that belong to no session are not affected; their signature waits expire after 24 hours
  ([Waiting for signatures](privilege.md#waiting-for-signatures)).

### Foreground and background

`subagent` runs a child in the foreground and waits for its answer, or with `background: true` returns
at once. Both return the `subagent` job id. A foreground wait is interrupted when the child needs a
decision from the parent's agent: the child keeps running, the parent decides, and then continues
waiting with `job_wait`.

### Handling subagent requests

- A task or external call approval request from a subagent goes up the chain to the first ancestor
  whose rules allow every operation in it; that agent approves, denies or escalates. If none allows it,
  or the agent escalates, Auto Review (for an Auto Review root) and otherwise the owner decides.
- A quota request goes to the direct parent of the exhausted level, and to the owner for a root.
- Pending requests are attached to every tool result of the handling session in a tagged JSON block
  that states the summaries come from subagents and are data, not instructions. Escaping keeps a summary
  from closing the block. Completion notices of finished jobs are attached beside it, in their own tagged
  block, and carry only a job's id, kind, action and outcome ([Completion notices](jobs.md#completion-notices)).
- An idle parent is woken with an input whose entry kind is `crh.notice`, not a user message: its data
  names the request (`{ "type": "agent_request", … }`) or the finished jobs (`{ "type": "jobs", … }`), so
  no display surface or transcript reader treats a wake as something the user typed. A running parent
  sees the request in its next tool result. There is no polling loop.

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
| `call_tool`/direct extension tool wait before returning | 10 minutes for agents, 30 seconds for MCP |

Node notes returned by `node_info` are cut to 8 KiB, because every call returns them. A node with notes
returns `{ path, content }`; a node without them returns `{ path, status }` and no `content`.

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
subagent, the owner in the WebUI for a root. The decider adds tokens or ends the run. Every tool
registration checks this before it runs, the directly listed extension tools and the subagent tools
included. The WebUI route and the chat commands share one decision function, which notes a scheduled
run's denial, settles the wait, and audits `quota.granted` / `quota.denied`.

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

## Provider network errors

pi-ai keeps only `error.message`, so Node's bare `terminated` or `fetch failed` would hide what happened.
`meteredModels` (`server/src/agent/metering.ts`) therefore wraps the fetch it passes to the adapters that
accept one — openai-completions, openai-responses, azure-openai-responses, openai-codex-responses,
anthropic-messages, mistral-conversations and pi-messages — and names the host and the phase (connecting
or reading the streamed response) while folding in the error's cause and code; a caller-provided fetch is
wrapped instead of the global one. An aborted request passes through unchanged, and HTTP error responses
are untouched. The Google adapters reject a custom fetch and Bedrock does not use fetch, so those keep
pi-ai's message.

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
- Auto Review sees the session's user instructions and tool calls plus the operation, never assistant
  text, tool results or node output, and each part is data in a fenced JSON block, so one injected text
  cannot steer both the agent and its reviewer.
- Subagent requests reach the parent as data in a tagged block that a summary cannot close.
- Skill descriptions come from files in the owner's library, which the agent itself can write, so a
  skill written in one session steers later ones, like a node note. The prompt quotes them as the
  owner's data, and library writes are audited ([Skills](library.md#skills)).

## Dependency versioning

The pi packages are pinned to exact versions in `server/package.json`, and an upgrade is a deliberate
change. pi-durable's storage interface, its model wrapper and its task hooks are the places where an
upgrade can compile and still be wrong: a storage change can break persistence, and a hook change can
charge the wrong calls or lose timings. An upgrade therefore runs the storage conformance suite on both
databases, the metering and statistics tests, the agent end-to-end tests and the performance suite
([Agent runtime tests](testing/server.md#agent-runtime-tests)), not just the type check.

# Todo list

A root session's agent keeps a todo list: the steps of the work it is doing and where each one stands.
The list guides the model through multi-step operations and shows the owner what the agent is working
on. This document describes the tool, where the list is stored, how it survives compaction, and the
background bar that shows it beside the session's jobs.

The shape follows what coding agents commonly train on (Claude Code's TodoWrite, Codex's
`update_plan`, opencode, the DeepSeek harness's `todo_write`): one tool that replaces the whole list,
three statuses, no ids. Two things differ from those agents because CRH sessions differ: the list is
never cleared by a turn boundary, because a session is woken by job completion notices in the middle of
its work ([Jobs](jobs.md#completion-notices)); and the list is attached to the compaction summary,
because long sessions are compacted ([Agent runtime](agent-runtime.md)).

## Why

- **Multi-step operations.** Rolling a change through node groups, upgrading crha, diagnosing a failure
  across several nodes: the agent starts background jobs, ends its turn, is woken by a notice and
  continues. A written list keeps the remaining steps explicit across those turns.
- **Visible progress.** The owner sees the plan and the current step without reading the transcript, in
  the same strip as the session's background jobs.

## Scope

- Only root sessions have the tool. A subagent works on one delegated task; its parent's list covers it.
  The tool is not offered to subagent sessions, and a call from any context without a root session is
  refused.
- Scheduled runs are root sessions and have the tool.
- The owner cannot edit the list; it is the agent's. Share viewers and administrators see it read-only.
- Chat channels do not show the list. They have no standing strip; a channel command to show it can come
  later.
- MCP clients do not get the tool: a client keeps its own plan.

## The tool

`todo_write(todos: [{ content, status }])`

- `todos` is the complete list and replaces the previous one. An empty array clears the list.
- `content` is one line: whitespace and control characters collapse to single spaces; trimmed, non-empty, at
  most 200 characters, unique within the list. The list holds at most 50 items.
- `status` is `pending`, `in_progress` or `completed`. Several items may be `in_progress` at once,
  because background jobs run in parallel.
- A call that breaks a rule is refused with an error result that names the rule, so the model corrects
  it; nothing is stored.
- The result is one line: `Updated todo list: 2 pending, 1 in progress, 3 completed.` The model already
  has the list in its own call.
- No approval: the tool changes nothing outside the session. Policy treats it like `job_list`.
- The tool is idempotent: a replay after a restart writes the same list again.

Description given to the model:

> Record and update a task list to plan multi-step work and show the owner your progress; skip it for a
> single quick step. Before you start, add one todo per concrete step. Keep the todos being worked on
> `in_progress`, several only when work runs in parallel (for example background jobs), and mark each one
> `completed` as soon as it is done. The list stays until you replace it: when you start unrelated work,
> write a new list, and write an empty list when nothing is left to track.

The system prompt adds one line in its tool guidance: use `todo_write` for operations with several steps
or several nodes, and keep it current while background jobs run.

## Storage

The current list is session state, not conversation history:

- `sessions.todos` (JSON, null when the session never had a list or the list was cleared) holds the
  current list. The tool writes it in the same step that checks the call, and publishes
  `todo.changed` on the session stream.
- The list stays until the model replaces it. No turn boundary, run end, wake or new user message clears
  it. A finished list (every item `completed`) stays visible until the model writes the next one.
- Forking a session copies its list with the conversation; a scheduled run starts without one.
- Deleting a session deletes its list with it.

The transcript keeps every `todo_write` call as an ordinary tool call, so the history of the plan is in
the conversation; the column is the fast read for the UI and for compaction.

## Compaction

A compaction replaces the older part of the conversation with a summary, and with it the `todo_write`
calls that held the list. The model must keep seeing its plan, so the list is attached to the summary:

- When a compaction is planned (`beforeCompact`), the current list is recorded as the list of that
  compaction.
- When a request is built (`beforeRequest`), the summary message gets a block after the summary text:

  ```text
  <todo_list at_compaction="true">
  [completed] Back up /etc/nginx on web-1..3
  [in_progress] Roll out the new config to web-1..3
  [pending] Verify that every node serves 200
  </todo_list>
  ```

  An empty list adds no block.
- The block is the list as it was at that compaction, frozen. It does not follow later writes, which the
  model sees as its own later calls, so the summary message, the start of every request, does not change
  with each update and the provider's prompt cache keeps working. A later compaction records a newer list
  and replaces the block.
- The block is added to the request only; the stored summary entry is unchanged.

## Background bar

The strip above the composer ([WebUI](webui.md#background-bar)) is always shown in a root session and
has two sides:

- **Left: background jobs.** As today: how many jobs are running and waiting, and the tree in a popover
  (a bottom sheet on narrow screens). With no active job it reads **0 background jobs** and opens
  nothing.
- **Right: the todo list.** The progress and the current item: `2/5 · Roll out the new config to
  web-1..3`, with more `in_progress` items counted as `+1`. It truncates; the full list opens in its own
  popover or sheet, one row per item with a status icon (done, active, pending). With no list the right
  side shows nothing.

A subagent session shows the bar with its jobs only. Both sides keep the width limits of the jobs tree:
long text truncates, nothing scrolls sideways.

A `todo_write` call renders in the transcript as one compact tool row: `3/5 done · Roll out the new
config to web-1..3`, opening the call's arguments like any tool row.

## API

- The session view (`GET /api/sessions/:id`) and the share view carry `todos`: the list or null.
- `todo.changed` on the session event stream carries the new list; the WebUI replaces its copy.
- There is no write endpoint.

## Documents that change with this design

- [Agent runtime](agent-runtime.md): the tool, its availability in root sessions only, and the list on
  the compaction summary.
- [WebUI](webui.md): the background bar's two sides and the `todo_write` row.
- [Data model](data-model.md): `sessions.todos`.
- [Access control](access-control.md): who sees the list.

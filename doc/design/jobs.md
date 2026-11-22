# Jobs

A job is the model's handle on work that one tool call started and that may outlive the call: an `exec`
task or task group, an extension call, or a subagent's run. The model gets one id, one way to wait, one
way to cancel and one completion notice, whatever runs underneath. This document describes the job
model, the tools, background extension calls, completion notices, the WebUI and chat surfaces, and
retention.

A job is a handle, not a control plane. Tasks, task groups, external calls and subagent sessions keep
their own records, state machines, approvals and signatures; the job layer reads them through one
adapter per kind and never writes their tables. Rules and approvals are therefore enforced exactly where
they are today, below the Cluster API and in the extension layer
([Architecture](architecture.md#layering-principles)). The adapter interface is the seam a later design
could use to move approval up to the job; nothing in this design depends on that.

## Why

- **One wait for everything.** `exec` could already return a still-running result and be followed with
  `task_wait`; a subagent had `subagent_wait`; an extension call could only block, and an MCP call over
  60 seconds failed ([Background extension calls](#background-extension-calls)). Each kind had its own
  id and its own tools.
- **Completion without polling.** A model that moved on had to poll to learn that background work had
  ended. Coding agents commonly deliver a completion notice instead, and wake an idle agent for it.
- **The model sees only job ids.** Task, task group, external call and child session ids stay in the
  WebUI and the API. Whatever happens to the records underneath later, the model-facing contract does
  not change.

## Scope

| Tool | Job kind | Underlying work |
|---|---|---|
| `exec` on one node | `exec` | One task |
| `exec` on several nodes | `exec` | One task group |
| `call_tool`, `ext__<extension>__<tool>`, `api_request` | `call` | One external call |
| `subagent` | `subagent` | The child session's run |

- Only tool calls make jobs: agent sessions and MCP clients. A task created by the WebUI's Run task
  dialog, by a channel command or by a schedule's own machinery has no job, because no model waits for
  it.
- File tools, `copy_file`, `view_image` and directory copies keep blocking until their tasks end and
  return no job id ([Tool categories](agent-runtime.md#tool-categories-and-shared-components)). They are
  short, and closing their request cancels their task so an abandoned write never lands later; a job
  would undo that guarantee. They do not become jobs.

## Job model

`jobs` holds one row per job:

| Column | Meaning |
|---|---|
| `id` | `<kind>-<16 hex>`, see [Ids](#ids) |
| `org_id`, `actor_type`, `actor_id`, `on_behalf_of_user_id` | Who started it, the same actor columns tasks use |
| `session_id` | The session whose tool call started it; null for an MCP client |
| `call_key` | The durable tool call key; unique |
| `kind` | `exec`, `call` or `subagent` |
| `resource_type`, `resource_id` | `task`, `task_group`, `external_call` or `session`, and its id |
| `action` | The job's `TaskAction`, the same structured action approvals show |
| `state`, `outcome`, `wait` | The projected state ([States](#states)) |
| `result` | A `call` job's rendered result while it is kept ([Results](#results)) |
| `notice` | `none`, `pending`, `delivered` or `collected` ([Completion notices](#completion-notices)) |
| `created_at`, `settled_at` | Times |

The row is a projection: `state`, `outcome` and `wait` are recomputed from the underlying record by the
kind's adapter whenever that record changes, serialized per job like session state recomputation, so two
quick changes cannot land out of order ([Session state](agent-runtime.md#session-state)). At startup,
after durable resumes runs and before crhs accepts requests, every unsettled job is reconciled with its
record.

### Ids

- **From a tool call.** The id is `<kind>-` followed by the first 16 hex digits of
  `derivedId("job:" + callKey)`, where `callKey` is the durable tool call's key
  (`String(api.taskId)`). A tool call that runs again after a restart finds the same job, as it already
  finds the same task, group, external call or child session, whose ids derive from the same key.
- **From an MCP client.** An MCP request has no durable call, so the key is a fresh random id and a
  retried request is a new job, as a retried MCP request is a new task today.
- The kind prefix tells the model what it is waiting for without another call. The id is not a
  capability: every operation checks ownership.

### Ownership

A job is visible to, and controlled by, the actor that started it and that actor's ancestors: the
session that made the call, its parent agents up to the root, and the root's owner in the WebUI. An API
token reaches the jobs that token started. This is the rule `task_wait` applies through `mayActFor` and
`subagent_wait` applies through `isDescendant`, stated once for every kind; another session of the same
user never reaches the job.

## States

Every adapter maps its record to one vocabulary:

| Job state | `exec` (task, task group) | `call` (external call) | `subagent` (child session) |
|---|---|---|---|
| `waiting` | `awaiting_approval`, `awaiting_authorization` | `awaiting_approval` | `awaiting` |
| `running` | `dispatched`, `running` | `running` | `running` |
| `settled` | Any terminal state | Any terminal state | Its run ended and it owns no unsettled job |

- `wait` names what a waiting job waits for: `approval`, `signature`, `quota` or `decision` (a subagent
  request its parent's agent must decide). It is derived from the same fields the decision panel reads,
  so the job never disagrees with the approval it shows.
- **Reviewing is running.** A request Auto Review is still judging is not a wait, for the job as for the
  session ([Auto Review](access-control.md#auto-review)).
- **A subagent's own jobs keep it unsettled.** A child that started background work and ended its run is
  not finished: its jobs' notices wake it, and its answer comes after them. The parent's `subagent` job
  settles only when the child is idle, every job the child owns has settled, and no notice of such a job is
  still `pending` or being delivered: a settled job whose wake has not run yet still owns the child's next
  turn. Past `jobs.max_consecutive_wakes`, though, a pending notice with no wake queued or in flight no
  longer keeps an idle child unsettled: no wake can run, so the parent's job settles with the answer the child
  already gave and the notice stays pending for a later turn. `job_wait` (and the foreground `subagent` tool)
  waits for that job settlement, not only for the child's run to end.
- **Settled is final.** Once `settled_at` is set, a projection never moves the job back to `running` or
  `waiting`, so a child that starts a new job later does not reopen its parent's settled job (that answer is
  already final, and a second notice could otherwise be sent).
- `outcome` is a `TaskOutcome`, the one classification every surface already reads
  ([Task outcome](execution.md#task-outcome)): a task's and group's come from `taskOutcome` and
  `taskGroupOutcome`; a call's state maps to `succeeded`, `error` (failed), `rejected`, `cancelled` or
  `unknown`; a subagent's run maps to `succeeded`, `error` or `cancelled`. `TaskOutcomeBadge` renders a
  job's outcome like a task's.

## Adapters

Each kind implements one interface, in the layer that owns its record:

```ts
interface JobSource {
	kind: JobKind;
	/** The projected state of the record behind the job; undefined once the record is gone. */
	project(job: JobRow): Promise<JobProjection | undefined>;
	/** Waits up to `ms` for the record to settle, or for a wait when `attention` is set. */
	wait(job: JobRow, ms: number, options: { signal?: AbortSignal; attention: boolean }): Promise<void>;
	/** Cancels the work through the record's own cancel path, recorded as `by`. */
	cancel(job: JobRow, by: Actor): Promise<boolean>;
	/** The model-facing result, the same text the starting tool returns. */
	render(job: JobRow, ctx: ToolContext): Promise<ToolResult>;
}
```

- `exec` uses `waitTask`, `taskGroups.wait`, `cancelTask` and the existing `execTaskResult` and group
  renderers; `call` uses the external call row and the stored result; `subagent` uses the runtime's
  `waitSubagent`, `stopSubtree` and the child's answer.
- The job layer calls only this interface. It never reads a task's columns or a session's durable
  state, and the adapters never write `jobs`; the projection writer does, from what `project` returns.

## Tools

The model gets three job tools and one convention for the tools that start jobs.

**Starting.** `exec`, `call_tool` (and the tools that run through it) take `wait`, the seconds to wait
for the result, at most 600 (600 by default in agent sessions, 30 for MCP clients, as `exec` today). A
job that settles in time returns its result exactly as the tool always has. Otherwise the tool returns
the waiting or still-running note with the job id: `[web-1, still running, job exec-3f2a…: call job_wait
with this id]`. `wait` is not a timeout: the work goes on. It counts the time spent waiting for an
approval or a signature as well, for every kind: a job still waiting for a person when `wait` runs out
returns the waiting note with the link, and its completion notice later reports the end. `subagent` keeps `background: true` and its
foreground wait; both return the job id instead of the child's session id.

| Tool | Purpose |
|---|---|
| `job_wait(job_id, wait?, attention?)` | Wait up to `wait` seconds and return the job's current result, text like the starting tool. With `attention` (default true) a job that starts waiting for this agent's decision returns at once, as `subagent_wait` did |
| `job_cancel(job_id, reason?)` | Cancel the job through its record's cancel path; a settled job returns its current state |
| `job_list(state?)` | This session's jobs: id, kind, the action line, state and outcome, newest first |

- They replace `task_wait`, `task_cancel`, `subagent_wait` and `subagent_cancel`. `subagent_list` and
  `subagent_decide` stay: they are about the subagent tree and its requests, not about waiting.
- `job_wait` on a settled job returns its result again for as long as the job is kept; reading it
  marks the notice `collected` and withdraws a notice not yet delivered.
- A job deleted by retention answers `no_such_job` with "the job is no longer kept".
- The MCP surface offers the same three tools; `doc/guide/mcp.md` changes with it.

## Background extension calls

A `call` job runs its MCP request in a crhs-owned runner, not in the tool invocation, so the request
survives the tool returning; the invocation only waits on it.

- **The timeout is the extension's.** The request passes the extension's `timeout_ms` (5 minutes by
  default) to the MCP SDK as `timeout`, with `resetTimeoutOnProgress` and `maxTotalTimeout: timeout_ms`.
  The SDK's 60-second default no longer cuts a call short, and a server that reports progress keeps the
  request alive up to the extension's limit. Today the SDK's own timeout fires first, and the call ends
  `unknown` and marks the extension unavailable.
- **Cancellation.** `job_cancel`, a stopped session and the timeout send an MCP cancellation, as an
  aborted tool call does today ([External calls](extensions.md#external-calls)).
- **Approval first.** A call waiting for approval is a `waiting` job; the runner starts it when it is
  approved, so `wait: 0` returns at once with the approval link and the job id.
- **Restart.** A call in flight when crhs stops still ends `unknown` and is never repeated; its job
  settles `unknown` and gets a notice. A call that was still waiting for approval is re-armed at startup;
  if its extension or acting user is gone, nobody could ever run an approval, so the row is finished
  `failed` (audited like any call finish) and its job settles there instead of staying `running` forever.

### Results

`external_calls` stays the "already ran" marker and still keeps no result. A call that settles while
nobody waits needs its result kept until the model reads it, so the `call` job stores the rendered
result in `jobs.result`: the text the model would have received, with the same truncation limits;
images are image cache references ([Results](extensions.md#results)). `exec` and `subagent` jobs store
no result: their tasks and transcripts already keep it. `extensions.md` changes from "the result is in
the transcript" to "the result is in the transcript, and in the job while the job is kept".

## Completion notices

When a job settles and no live wait collected it (the starting tool's own wait or a `job_wait` in
progress), its owner gets a notice.

- **Busy owner.** The notice is attached to the next tool result, beside pending subagent requests and
  in the same kind of tagged block ([Handling subagent requests](agent-runtime.md#handling-subagent-requests)).
  Several jobs settling together cost one block.
- **Idle owner.** The owner is woken: crhs submits an input whose entry kind is `crh.notice` instead of
  `pi.user` (pi-durable places an input as any kind outside `pi.`), with `{ type: "jobs", jobs: [...] }`
  as its data and a short model-facing text as its content. The model reads it like any input; every display
  surface reads the kind and the data, never the text.
- **Metadata only.** The notice names each job's id, kind, action and outcome. It carries no output:
  node output and MCP content are untrusted, and an input reaches the model with more authority than a
  tool result ([Prompt injection](agent-runtime.md#prompt-injection)). The model calls `job_wait` to read
  the output as a tool result.
- **Not a user message.** Session search, title generation, Auto Review's user instructions, the chat
  history, `last_used_from` and the time note ignore `crh.notice` entries ([Message time](agent-runtime.md#message-time)).
- **Wake cap.** A session may be woken by notices at most `jobs.max_consecutive_wakes` times (System
  settings, 10 by default) since the last user-authored input. Past the cap, notices wait in the next
  tool result or the next user turn. This bounds a self-exciting chain, a woken turn starting the job
  whose completion wakes it again.
- **State.** `jobs.notice` goes `pending` when the job settles uncollected, `delivered` when a notice
  carrying it is placed, and `collected` when `job_wait` reads it. At startup, pending notices of
  settled jobs are delivered; a job collected in the meantime is skipped.
- **One delivery per session.** Notice delivery is serialized per session, so two jobs settling together
  produce one `crh.notice` input listing both instead of duplicate wakes (and duplicate wake-cap counts).
- **Wake text.** The short model-facing text collapses whitespace and clips each action to 200 characters:
  a multi-line shell command must not read as several lines outside the escaped JSON block.
- **MCP clients** get no notices: an MCP client has no session to wake. It reads jobs with `job_wait`.

The existing subagent request wakes move to the same entry kind, with `{ type: "agent_request", ... }`
or `{ type: "quota_request", ... }` as data, so one rendering path serves both: a request wake is no
longer shown as a user message either.

### Display

- **WebUI.** A `crh.notice` entry is one centered line in muted grey text, outside any message
  bubble: "Background job finished: <action> · <outcome>", and "· the agent was woken" when the entry
  started a run. Several jobs list as one line each. Each job links to its resource page.
- **Chat channels.** The same line is sent where the session's text goes
  ([Notifications](channels.md#notifications)), rendered from a compact, locale-free `JobNotice` model
  the server builds, as approval cards are rendered from `ApprovalRequest`: Markdown for Telegram, plain
  text for Satori. The assistant reply that follows is ordinary text and is routed as usual. A notice
  does not mark the session read.
- A scheduled run's session sends its notices nowhere, like its assistant text.

## Approvals and jobs

Approvals stay on their records, one decision each. Two things reuse the approval model instead of adding a
second one:

- **The job names its approvals.** `ApprovalRequest` gains an optional `job` (`id`, `kind`, `action`),
  set when a waiting task, task group or external call belongs to a job. The chat cards show it as
  context.
- **One action and source model.** A job carries the same `TaskAction` and `RequestSource` an approval
  carries, so the background bar, the notice line and the approval card describe the same work in the
  same words. `TaskAction` gains a `subagent` variant (the task's first line, clipped).

## WebUI

- **Background bar.** The subagent bar becomes the background bar, one side of an always-shown strip
  ([Todo list](todo.md#background-bar)). Its side lists the session's active jobs only, running or
  waiting; a settled job leaves it, and so does an idle subagent. With no active job it reads
  **0 background jobs** and opens nothing. Its line shows the counts of running and waiting jobs;
  expanding it shows one row per job with its kind icon, action, state and elapsed time. Subagents are `subagent` jobs; a subagent's
  own active jobs are nested under it, and a level still loads one page at a time.
- **No job pages.** A job has no page of its own, and neither does an external call. A row whose job
  has a resource page — a task, a task group or a subagent session — links to it, and stopping happens
  there, with that page's own control. A row without one — an extension call — shows a Stop button
  (`POST /api/jobs/:id/cancel`) instead. Only the session owner gets Stop; share viewers and
  administrators see the row without it, as they never see the extensions button
  ([Session header](webui.md#session-header)).
- **Narrow screens.** Below the mobile breakpoint the bar opens as a bottom sheet. Today's subagent bar
  never opens there: its trigger opens the desktop popover only, and the sheet branch has no control that
  sets it open. The background bar's trigger opens both.
- **Tool rows.** A tool result's details carry the job id. A row whose job has not settled shows the
  background state and follows `GET /api/jobs/:id` every few seconds, replacing the per-kind polling of
  tasks, groups and sessions ([Message rendering](webui.md#message-rendering)). The dialog links to the
  job's resource page when it has one; an extension call waiting for approval links to its approval
  page, as today.

## API

| Route | Purpose |
|---|---|
| `GET /api/jobs?session=…` | A session's jobs, cursor paginated |
| `GET /api/jobs/:id` | One job: `JobView` with its resource reference |
| `POST /api/jobs/:id/cancel` | Cancel, as `job_cancel` |

The session event stream carries `job.changed` events, and `@crh/api` gains `JobView` and `JobNotice`.
Visibility follows [Ownership](#ownership): the session's owner and its share viewers see a session's
jobs, and only the owner cancels.

## Lifecycle and retention

- **Run end.** A run that ends leaves its jobs running: that is what a background job is for. The rule
  that ends waits left by tool calls that no longer exist counts a live job as a holder, so a background
  job's approval wait is not ended with the run that started it
  ([Session state](agent-runtime.md#session-state)).
- **Stop.** Stopping a session stops its jobs, as it already cancels its running tasks and stops its
  subtree: tasks are cancelled, calls get an MCP cancellation, subagents are stopped, and approval waits
  are rejected. Schedule preemption stops a run the same way. Before any of that runs, every unsettled job
  of the stopped tree is marked `collected` durably, so a job that settles during the stop (or after a
  restart) cannot wake the session the user just stopped.
- **Scheduled runs.** A scheduled run is final when its session is idle and owns no unsettled job, not
  when its first run ends, so a report is sent after the background work and its woken turns
  ([Scheduled tasks](scheduling.md)).
- **Limit.** A session may have at most `jobs.max_running` unsettled jobs (System settings, 32 by
  default); a tool that would start another fails with `job_limit`. Foreground calls count while they
  wait. The count check and the job's creation are serialized per session or API token, so parallel tool
  calls cannot all pass the same check.
- **Retention.** A settled job is deleted with finished tasks, by the task retention setting and never
  sooner than one day after `settled_at`, because a tool call that reruns after a crash finds its job by
  id ([Retention](data-model.md#retention)). Unsettled jobs are never deleted. The underlying records keep
  their own retention; a job whose record is gone shows "details no longer kept" instead of failing.
- **Session deletion** stops and silences its jobs first, then deletes them with the row: a call or child
  that settles during the removal never wakes the session being deleted.

## Documents that change with this design

- `agent-runtime.md`: the cluster tool table, `exec` semantics, subagent control tools, foreground and
  background, request wakes.
- `extensions.md`: background calls, the SDK timeout, results kept in the job.
- `access-control.md`: `ApprovalRequest.job`.
- `webui.md`: the background bar (replacing the subagent bar), tool rows, the notice line.
- `channels.md`: notice lines.
- `scheduling.md`: when a run is final.
- `data-model.md`: the `jobs` table and its retention.
- `doc/guide/mcp.md` and the tool descriptions: the job tools.

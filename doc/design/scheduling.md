# Scheduled tasks

The scheduler is a server module (`server/src/scheduler/`) built on database tables. It does not use
durable's timer mechanism: it wakes on a timer, writes a run record for every due trigger, and
submits each run by calling the agent runtime.

## Schedule model

A scheduled task has one shape: on a timetable, it submits a fixed user message into a new session.
A fixed command that must run on a timetable is run by the agent inside that session, so its rule
chain, approvals, privilege and quota are those of an ordinary session. The scheduler talks only to
`AgentRuntime`; it never creates tasks itself.

| Field | Meaning |
|---|---|
| `name` | The schedule's name; it becomes the title of every session a run creates. |
| `prompt` | The user message submitted to each new session. |
| `model` | The model the session runs on. |
| `rulePreset` | The rule preset (`ask`, `auto_review` or `yolo`); the schedule is the root of its sessions' rule chain, see [Rules and quotas](#rules-and-quotas). |
| `token_budget` | The token limit of one run, written as the new session's root quota; `null` means unlimited. |
| `cron` / `timezone` | A five-field cron expression with minute precision, parsed by `croner`, and an IANA time zone; daylight-saving changes follow `croner`. |
| `catch_up` | Whether one trigger missed during downtime runs afterwards. |
| `enabled` | Whether timed triggers fire. |

The name is 1 to 200 characters after trimming, the prompt is non-empty and at most 100,000
characters, and `token_budget` is `null` or a positive integer. Saving a schedule validates the cron
expression and the time zone: an unknown zone is rejected at once rather than when the first trigger
is computed, and the expression must have exactly five fields. The API also previews the next fire
times for the form.

Every run's session belongs to the schedule's owner, and `sessions.schedule_id` points at the
schedule, so the session list can filter by schedule. The rows in `schedule_runs` are the trigger
history, and each row links the session it created. A scheduled session takes the schedule's name as
its title and never generates one. The stored columns are in
[Scheduled tasks](data-model.md#scheduled-tasks).

## One instance at a time

A schedule has at most one running instance. When a new run starts, whether timed or manual, and the
previous instance has not ended, crhs ends it forcibly: it goes through the session stop path,
cancels the instance's tasks and subagent subtree, marks the run `preempted`, and only then starts
the new run. A run that has been claimed for submission but is still `pending` counts as an
instance and is preempted too, so two submissions never run side by side.

A run is `succeeded` when its root submission ends, but background subagents it started may still be
running. The next trigger examines the schedule's finished runs (`succeeded`, `failed` and
`preempted`); if their session tree still contains `running` or `awaiting` work, it stops that
session with the same stop path, and `abort` covers the whole subtree. An idle session produces no
operation. The stopped run keeps its status and a `schedule.leftover_stopped` audit row is written,
so "one instance at a time" also covers background work left by the previous instance.

The previous instance is ended the same way when it waits for an approval, a signature or quota. A
period shorter than the time the owner needs to handle the wait means every run is ended before it
can be handled. This is intended: each run is valid only until the next trigger. Tasks already
executing on nodes are cancelled, which can leave a half-done state on the node.

## Triggering and submission

Triggering and submitting are two steps, so a crash between them neither loses nor duplicates a run.

1. **Trigger.** The loop wakes at the earliest `next_run_at`, at most every 60 seconds so a clock
   jump is noticed, and at once when a schedule is created or changed. In one transaction it
   inserts a `pending` row into `schedule_runs`, unique on `(schedule_id, fire_time)`, and moves
   `next_run_at` forward with a conditional update on the old value. The `schedule.fired` audit row
   is written after the commit because the audit write is not part of that transaction: a crash
   between the two loses only that audit row, while the run record itself is consistent. A
   duplicate trigger is rejected by the unique index, after which the scheduler moves the next time
   forward (or disables a schedule whose cron has no later firing), so it does not retry the same
   trigger forever.

2. **Submit.** A submitter claims each `pending` run with a conditional update of `started_at`, ends
   the previous instance as described above, creates a session and submits `prompt`, and then marks
   the run `running`. The identifiers come from the run record, so a repeated submit is idempotent:
   the session id is derived from the run id, and `requestId` is
   `schedule:<schedule_id>:<fire_time>`; durable deduplicates submissions by that request id.

3. **Recovery.** At startup crhs first stops the sessions of `preempted` runs that are still running
   (preemption marks the run before it stops the session, so a crash in between leaves such a
   session), then submits the leftover `pending` runs, and then starts the loop. A crash after the
   submit but before the `running` write is covered by the idempotent submit. Sessions that were
   running continue through durable's restart recovery.

4. **Finish.** A run whose root submission ends normally is `succeeded`. An error, an abort or a
   stop makes it `failed` with a `reason`, for example that the owner denied the token quota. A run
   ended by the next one is `preempted`. The agent's own judgement, such as an inspection that found
   a problem, is not a failure; the status describes execution only. At startup crhs reconciles
   `running` rows and fills in runs that ended during downtime.

**Missed triggers.** On startup, or after a clock jump, `next_run_at` can be more than the tolerance
of 60 seconds in the past. With `catch_up = false` the missed times are skipped; with
`catch_up = true` only the most recent missed time runs. Both cases write an audit row and recompute
`next_run_at` from the current time. Runs already written as `pending` are always submitted,
whatever `catch_up` says.

**Manual run.** The WebUI's "Run now" takes the same path with `manual = true`, `fire_time` set to
the click time and the clicking user as actor. When an instance is running, the UI first asks for
confirmation that the current run ends. A disabled schedule can be run manually; disabling
stops only timed triggers.

**Trigger failures.** When firing a schedule throws, the scheduler backs off by consecutive
failures: with a conditional update on the old value, it moves `next_run_at` to the current time
plus 1 minute, then 2, 4, and so on, capped at 1 hour, and one successful pass resets the count. A
concurrent edit keeps the time it chose. The loop therefore does not retry a failing trigger at a
0 ms interval. When the cron has no further fire time, for example 30 February, the
current trigger still writes a run and executes once; it is the last trigger, neither lost nor
duplicated. The schedule is then disabled (`enabled = 0`, `next_run_at = null`) and a
`schedule.disabled` audit row is written with `reason = never_fires`.

## Audit

Every scheduler decision writes an audit row with the schedule as target. Scheduler decisions use
the actor `system` with id `scheduler` and the owner as `on_behalf_of_user_id`; configuration
changes and manual runs use the acting user.

| Event | Content |
|---|---|
| `schedule.created`, `schedule.updated`, `schedule.deleted`, `schedule.enabled`, `schedule.disabled` | Configuration changes. `schedule.disabled` carries a `reason`: `never_fires` when the cron has no further firing time, `owner_disabled` when the owner was disabled. |
| `schedule.fired` | A timed or manual trigger, with the run id, `fire_time` and `manual`. |
| `schedule.skipped` | No trigger fired, with the reason: a missed trigger while `catch_up = false`, the schedule disabled, or the owner disabled. |
| `schedule.run_started` | The run id and the session id. |
| `schedule.run_preempted` | The previous instance was ended, with its run id and session id. |
| `schedule.leftover_stopped` | Background work of a finished run was stopped at the next trigger, with its run id and session id; the run's status is unchanged. |
| `schedule.run_finished` | `succeeded` or `failed`, with the reason. |

## Rules and quotas

The schedule is the root of the rule chain for every session a run creates, above the session and
its subagents. The owner chooses the rule preset and may add rules on top of it; the preset and the
extra rules are stored in the schedule's `rule_sets` row with `scope_type = schedule`. See
[Authorization rules](access-control.md#authorization-rules) and
[Rule chain](access-control.md#rule-chain).

With the `ask` preset, every run's approvals wait for the owner; unattended, a waiting task lasts
until the next trigger ends it. The create form says so. With `auto_review` and no separate review
model configured, the schedule's own model performs the review.

`token_budget` is the quota on the root of each run's new session. It is counted in model output
tokens and excludes input, as described under
[Quota and token accounting](agent-runtime.md#quota-and-token-accounting). When the quota is
exhausted the run pauses and asks the owner to raise it or deny it; nobody handling the wait means
the next trigger ends the run. Changing the budget affects only later runs.

## Privilege

Privileged tasks in a scheduled session follow the ordinary authorization path; see
[Authorization path](privilege.md#authorization-path). A signature wait goes only to the owner:

- When crhs trust entries can authorize the task on their own and the rules and Auto Review allow it,
  the task runs automatically.
- When only the owner's user trust entry can authorize it, crhs first looks for a reusable
  authorization the owner already issued: still valid, carrying a `deadline`, and covering this task.
  The match considers the addressed nodes, the command limit and the deadline; it depends on the
  task's owner, not on the actor that started the task. If none is found, the task enters
  `awaiting_authorization` and appears in the owner's list of signature waits.

To let a fixed command run privileged without attendance, the owner can pre-issue an authorization
without `task_ids` for that command: `command.exact`, the target nodes, and a mandatory `deadline`.
The prompt must then ask the agent to run exactly that command; a slightly different spelling does
not match and produces a signature wait instead. The schedule page explains this and links the
authorizations page; it does not manage authorizations itself.

The privileged mode does not check the schedule time. Before the deadline, whoever holds the
authorization can execute the command at any time. When every execution must pass crhs's policy,
add `require-cosign` to the user trust entry.

## Lifecycle

- When the owner is disabled, crhs disables every enabled schedule of that user and writes
  `schedule.disabled` with `reason = owner_disabled`.
- Changing `cron`, `timezone` or `enabled` recomputes `next_run_at`: it becomes null while disabled
  and is computed from the current time when the schedule is enabled again. Changing `name`,
  `prompt`, `model` or `token_budget` affects only later runs.
- Changing `rulePreset`, or the rules added on top of it, takes effect at once, including on the
  running instance and its waiting approvals. The schedule is the root of the chain, so the effect
  is the same as changing a session's rule preset.
- Disabling a schedule does not end a running instance. Deleting it does: the run stops, its run
  rows are deleted, and `sessions.schedule_id` is set to null on its sessions. Those sessions were
  inherit-only levels below the schedule; deletion promotes each to a root rule set that carries the
  schedule's preset and rules, so the effective rules do not change. The schedule's own rule set is
  kept so that rule chains recorded on existing tasks still resolve.
- Schedules cannot be shared. MCP and the agent tools cannot manage them; only the WebUI and the API
  can.

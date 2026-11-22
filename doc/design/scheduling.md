# Scheduled tasks

The scheduler (`server/src/scheduler/`) is built on database tables rather than durable's timers: it
wakes on a timer, records a run for every due trigger, and submits each run through the agent runtime.

## Schedule model

A scheduled task has one shape: on a timetable, it sends a fixed user message to a new session. A command
that must run on a timetable is run by the agent in that session, so rules, approvals, privilege and
quota work exactly as in any session. The scheduler never creates tasks itself.

A schedule has a name (which titles its sessions), a message, a model, a rule preset, an optional token
budget per run, a five-field cron expression with an IANA time zone, a `catch_up` flag and an enabled
flag. Cron expressions and time zones are validated when the schedule is saved, not when it first fires.

Every run's session belongs to the schedule's owner and is linked to the schedule and its run record. A
schedule is a template: at creation each run's session receives its own root rule set copied from the
schedule's current preset and custom rules, so the schedule is never part of a rule chain.

## One instance at a time

A schedule has at most one running instance. When a new run starts, timed or manual, and the previous one
has not ended, crhs stops the previous session (including its tasks and subagents), marks its run
`preempted`, and then starts the new run. This also applies to background subagents that a finished run
left running.

The previous instance is stopped even when it is waiting for an approval, a signature or quota. Each run
is valid only until the next trigger; if the owner cannot respond within one period, every run will be
stopped before it is handled. Stopping cancels tasks on nodes, which can leave half-done work.

## Triggering and submission

Triggering and submitting are separate steps, so a crash between them neither loses nor duplicates a run.

1. **Trigger.** The loop wakes at the next due time (and at least every minute, to notice clock jumps).
   In one transaction it records a `pending` run, unique per schedule and fire time, and advances the
   schedule's next time. A duplicate trigger is rejected by the unique constraint.
2. **Submit.** A submitter claims the pending run, stops the previous instance, and creates the session
   with its first message, the schedule's prompt. Its sent time is in the schedule's time zone
   ([Message time](agent-runtime.md#message-time)). The session id and request id are derived from the run, so repeating the
   submission is idempotent.
3. **Recovery.** At startup crhs finishes interrupted preemptions, submits leftover pending runs, and
   reconciles runs that ended while it was down. Running sessions continue through durable's recovery.
4. **Finish.** A run is final when its session is idle and owns no unsettled job, and is `succeeded`
   then and `failed` on an error, abort or stop. Background work the run started and the turns its
   completion notices wake are part of the run, so its report follows them
   ([Jobs](jobs.md#completion-notices)). The status describes execution only; an agent reporting a
   problem it found is still `succeeded`.

**Missed triggers.** If triggers were missed while crhs was down or the clock jumped, `catch_up = false`
skips them and `catch_up = true` runs only the most recent one. Either way, crhs computes the next time
from now.

**Manual runs** ("Run now") take the same path and work on disabled schedules too; disabling stops only
timed triggers.

**Failures.** A trigger that fails backs off exponentially up to an hour instead of retrying in a tight
loop. A cron expression with no further fire time runs its last trigger and then disables the schedule.

## Audit

Every scheduler decision (fired, skipped, run started, preempted, leftover work stopped, finished) and
every configuration change is audited with the schedule as target. Scheduler decisions are attributed to
the system acting for the owner; changes and manual runs to the acting user.

## Reports

A schedule may report every finished run to one of its owner's linked chat accounts, in that account's
private chat. The setting is optional: a target account and a filter. Only an account linked to the
schedule's owner is accepted. The filter is `always`, only on failure, or only on success; a failed run is
one that ends `failed` or `preempted`, where preempted means stopped by the next run
([One instance at a time](#one-instance-at-a-time)).

The report is sent once, when the run's status becomes final and the filter matches. It has:

- one status line naming the schedule, the outcome and the trigger time, in the schedule's time zone (there
  is no user time-zone setting), localized by the receiving account's locale rule
  ([Messages](channels.md#messages));
- the full final reply of the run's first turn — the scheduled prompt's turn — not truncated, split like any
  other outbound text ([Messages](channels.md#messages));
- the files the run delivered with `copy_file` to `user_interface`, as WebUI download links, never
  attachments;
- the recorded error when the run failed;
- the session's WebUI link, or on Telegram an **Open session** button, like a default-account notice.

It goes to the private chat's main conversation, not a new topic, and is formatted as a message naming the
session, like the default-account notice. When the run has no final reply (failed or preempted mid-turn) the
report is the status line, the link and, when one is recorded, the error.

A sent report marks the run's session read for its owner, so it shows no unread dot in the WebUI
([Messages](channels.md#messages)).

A report is not a text push: it is the schedule's own message to the account its owner chose. Delivery is
in-process and best effort like every other channel message: a failure is logged, and there is no outbox, no
retry and no stored report state. A run that finished while crhs was down and is reconciled at startup sends
no report.

**No text pushes for runs.** A run session whose latest user message has no source — a scheduled run nobody
has written in since — pushes no assistant text (commentary or final answer), delivered-file link, turn error
or progress to any chat. Requests that need the user still go where they go for a WebUI session: approvals,
signature requests and used-up quota go to the WebUI while the owner is online there, otherwise to the
default notification account. Once the owner writes in the run session from the WebUI or a chat, its source
is set and normal rules apply again. API-token approvals without a session are unchanged.

## Rules and quotas

A schedule is a template for rules, not a level of them. At creation the run's session becomes an ordinary
root whose rule set is copied from the schedule's current rule preset and custom rules
([Rule chain](access-control.md#rule-chain)); the run, its subagents and its approvals use that copy.
"Always allow" on a run's approval appends to the run session's own root, so it affects that run only,
never the schedule. Editing the schedule's preset or rules changes only the copies future runs get; a run
session already created, and anyone still talking in it, keeps its own rules.

With Ask, every approval waits for the owner, and an unattended run waits until the next trigger stops it.
With Auto Review and no review model configured, the run session's model reviews.

The token budget becomes the quota of each run's root session ([Quota and token
accounting](agent-runtime.md#quota-and-token-accounting)). When it runs out, the run pauses and asks the
owner; stopping it from the WebUI or the chat ends the run failed with the denial as its reason.

## Privilege

Privileged tasks follow the ordinary [authorization path](privilege.md#authorization-path); signature
requests go only to the owner. A task runs unattended if the node trusts crhs for it, or if the owner has
already signed a reusable authorization that covers it.

To run a fixed privileged command unattended, the owner signs a reusable `spec` authorization for that
command with a deadline, and the message asks the agent to run exactly that command; any other spelling
does not match and waits for a signature. The node does not know the timetable, so such an authorization
works at any time before its deadline. If every execution should also pass crhs's rules, the owner's
trust entry can require a crhs cosignature: each run then carries crhs's cosign ticket for that run.

## Lifecycle

- Disabling the owner disables their schedules.
- Changes to the timetable or enabled flag recompute the next run time. Changes to the message, model,
  budget or rules affect later runs only: an existing run session keeps the rule set it was created with,
  including the approvals of that session.
- Disabling a schedule does not stop a running instance; deleting it does. The sessions remain as they
  were, each already a root with its own rules and any rules added during its run; nothing is promoted.
  The schedule's own rule set is kept so rule chains that past tasks recorded before runs became
  independent roots still resolve.
- Unlinking a chat account that is a schedule's report target clears the target and audits the schedule
  change, so a report is never sent to an account that is no longer the owner's.
- Schedules cannot be shared, and only the WebUI and the API manage them, not MCP or agent tools.

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

Every run's session belongs to the schedule's owner and is linked to the schedule and its run record.

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
   with its first message. The session id and request id are derived from the run, so repeating the
   submission is idempotent.
3. **Recovery.** At startup crhs finishes interrupted preemptions, submits leftover pending runs, and
   reconciles runs that ended while it was down. Running sessions continue through durable's recovery.
4. **Finish.** A run is `succeeded` when its session's run ends normally and `failed` on an error,
   abort or stop. The status describes execution only; an agent reporting a problem it found is still
   `succeeded`.

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

## Rules and quotas

The schedule is the root of the rule chain for its sessions, configured by a rule preset plus extra
rules ([Rule chain](access-control.md#rule-chain)). With Ask, every approval waits for the owner, and an
unattended run waits until the next trigger stops it. With Auto Review and no review model configured,
the schedule's model reviews.

The token budget becomes the quota of each run's root session ([Quota and token
accounting](agent-runtime.md#quota-and-token-accounting)). When it runs out, the run pauses and asks the
owner.

## Privilege

Privileged tasks follow the ordinary [authorization path](privilege.md#authorization-path); signature
requests go only to the owner. A task runs unattended if the node trusts crhs for it, or if the owner has
already signed a reusable authorization that covers it.

To run a fixed privileged command unattended, the owner signs a reusable `exact` authorization for that
command with a deadline, and the message asks the agent to run exactly that command; any other spelling
does not match and waits for a signature. The node does not know the timetable, so such an authorization
works at any time before its deadline. If every execution should also pass crhs's rules, the owner's
trust entry can require a crhs cosignature.

## Lifecycle

- Disabling the owner disables their schedules.
- Changes to the timetable or enabled flag recompute the next run time. Changes to the message, model or
  budget affect later runs only. Rule changes apply at once, including to a running instance and its
  waiting approvals.
- Disabling a schedule does not stop a running instance; deleting it does. The sessions remain; their
  rules are copied onto them so their effective rules do not change, and the schedule's rule set is kept
  so recorded rule chains still resolve.
- Schedules cannot be shared, and only the WebUI and the API manage them, not MCP or agent tools.

/**
 * The API's job view (doc/design/jobs.md "API"): one stored job row as `JobView`, with its action, outcome and
 * resource parsed from their columns. Shared by the job routes and the session event stream, so both send the
 * same shape. The job layer never builds this: it does not import the API layer.
 */
import type { JobView, TaskAction, TaskOutcome } from "@crh/api";
import type { JobRow } from "../jobs/types.ts";

/** One job change as the session event stream sends it (doc/design/jobs.md "API"). */
export function jobChangedEvent(job: JobRow): { type: "job.changed"; job: JobView } {
	return { type: "job.changed", job: jobViewOf(job) };
}

export function jobViewOf(job: JobRow): JobView {
	return {
		id: job.id,
		kind: job.kind,
		state: job.state,
		wait: job.wait,
		outcome: parseOutcome(job.outcome),
		action: parseAction(job.action),
		sessionId: job.session_id,
		resource: { type: job.resource_type, id: job.resource_id },
		createdAt: job.created_at,
		settledAt: job.settled_at,
	};
}

function parseOutcome(value: string | null): TaskOutcome | null {
	if (value === null) return null;
	try {
		return JSON.parse(value) as TaskOutcome;
	} catch {
		return null;
	}
}

function parseAction(value: string): TaskAction {
	try {
		return JSON.parse(value) as TaskAction;
	} catch {
		// A row whose action cannot be read still has a kind; the display surfaces fall back to it.
		return { type: "exec", command: "" };
	}
}

/**
 * One ownership check for every job tool (doc/design/jobs.md "Ownership"): the caller is the job's actor, an
 * ancestor agent of it, or the API token that started it. Another session of the same user is out of reach,
 * the rule the task and subagent follow-up tools applied before jobs. A foreign job answers like a missing one.
 */
import { sessionDescendants } from "../sessions/session-chain.ts";
import type { ToolContext } from "../tools/catalog.ts";
import { UserError } from "../util/errors.ts";
import type { JobRow } from "./types.ts";

export async function jobForCaller(ctx: ToolContext, id: string): Promise<JobRow> {
	const job = await ctx.jobs?.get(id);
	if (!job || !(await mayReachJob(ctx, job))) throw new UserError("the job is no longer kept", "no_such_job");
	return job;
}

/** Whether this caller may see and control the job. */
export async function mayReachJob(ctx: ToolContext, job: JobRow): Promise<boolean> {
	// A job belongs to the user it acts for; a token of another user never reaches it.
	if (job.on_behalf_of_user_id !== ctx.user.userId) return false;
	if (ctx.actor.type === "api_token") {
		return job.actor_type === "api_token" && job.actor_id === ctx.actor.id;
	}
	if (ctx.actor.type !== "session" && ctx.actor.type !== "subagent") return false;
	if (job.actor_type === ctx.actor.type && job.actor_id === ctx.actor.id) return true;
	// Only a session has a subtree; the job's actor must be inside it.
	if (job.actor_type !== "session" && job.actor_type !== "subagent") return false;
	const descendants = await sessionDescendants(ctx.db, ctx.actor.id);
	return descendants.includes(job.actor_id);
}

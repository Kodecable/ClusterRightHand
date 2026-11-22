/**
 * The running-job limit (doc/design/jobs.md "Lifecycle and retention"): a session may have at most
 * `jobs.max_running` unsettled jobs, and an API token the same count over MCP. A tool that would start another
 * fails with `job_limit` before it creates the task, external call or child session. Foreground calls count
 * while they wait, because their job is unsettled until they return.
 *
 * A replayed tool call is not blocked: it finds the job its first attempt created (`Jobs.forCall`), so a restart
 * at the limit cannot lose work that already started.
 */
import { DEFAULT_JOBS_MAX_RUNNING } from "../settings/settings.ts";
import type { ToolContext } from "../tools/catalog.ts";
import { UserError } from "../util/errors.ts";
import { errorResult, type ToolResult } from "../util/tool-result.ts";

/** The scope whose limit a start counts against: a session (a child is its own session) or an API token. */
function scopeOf(ctx: ToolContext): string {
	return ctx.actor.type === "api_token" ? `token:${ctx.actor.id}` : `session:${ctx.actor.id}`;
}

/** The refusal a tool returns at the limit, or undefined when it may start. */
export async function jobLimitResult(
	ctx: ToolContext,
	kind: "exec" | "call" | "subagent",
	callKey: string,
): Promise<ToolResult | undefined> {
	const jobs = ctx.jobs;
	if (!jobs) return undefined;
	if (await jobs.forCall(kind, callKey)) return undefined;
	const limit = ctx.jobsMaxRunning ?? DEFAULT_JOBS_MAX_RUNNING;
	const sessionId = ctx.actor.type === "session" || ctx.actor.type === "subagent" ? ctx.actor.id : null;
	const running =
		sessionId !== null
			? await jobs.unsettledCount(sessionId)
			: ctx.actor.type === "api_token"
				? await jobs.unsettledTokenCount(ctx.actor.id)
				: 0;
	if (running < limit) return undefined;
	const scope = sessionId !== null ? "this session" : "this API token";
	const message =
		`${scope} already has ${running} unsettled job${running === 1 ? "" : "s"} (jobs.max_running is ${limit}); ` +
		"wait for one with job_wait, or raise the setting to start another";
	return errorResult("text", "job_limit", message);
}

/** The same refusal as a thrown `UserError`, for callers that do not return a tool result. */
export async function assertJobLimit(
	ctx: ToolContext,
	kind: "exec" | "call" | "subagent",
	callKey: string,
): Promise<void> {
	const refused = await jobLimitResult(ctx, kind, callKey);
	if (!refused) return;
	throw new UserError(refused.content[0]?.text ?? "the job limit is reached", "job_limit");
}

/**
 * Runs `start` under the session's job-limit lock, re-checking the count first: either it returns the refusal to
 * the tool, or the work started with its job created inside the same lock, so a parallel call cannot slip in.
 */
export async function withJobLimit<T>(
	ctx: ToolContext,
	kind: "exec" | "call" | "subagent",
	callKey: string,
	start: () => Promise<T>,
): Promise<{ refused: ToolResult } | { value: T }> {
	if (!ctx.jobs) return { value: await start() };
	return ctx.jobs.withLimitLock(scopeOf(ctx), async () => {
		const refused = await jobLimitResult(ctx, kind, callKey);
		if (refused) return { refused };
		return { value: await start() };
	});
}

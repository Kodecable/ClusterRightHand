/**
 * The three job tools (doc/design/jobs.md "Tools"): one wait, one cancel and one list for every kind of work.
 * They are defined once with the cluster tools, so agent sessions and MCP clients get them both.
 */
import * as z from "zod/v4";
import type { ClusterTool, ToolContext } from "../tools/catalog.ts";
import { UserError } from "../util/errors.ts";
import { jsonResult } from "../util/tool-result.ts";
import { actionText } from "./action.ts";
import type { Jobs } from "./jobs.ts";
import { outcomeOf } from "./jobs.ts";
import { jobForCaller } from "./ownership.ts";
import type { JobRow } from "./types.ts";

const jobIdField = z
	.string()
	.min(1)
	.describe("The job id a starting result returned, such as exec-3f2a1b0c9d8e7f60, call-… or subagent-…");
const attentionField = z
	.boolean()
	.optional()
	.describe(
		"Stop waiting when the job starts waiting for your attention, e.g. a subagent request you must decide " +
			"(default true)",
	);

function jobsOf(ctx: ToolContext): Jobs {
	if (!ctx.jobs) throw new UserError("jobs are not available on this surface", "unavailable");
	return ctx.jobs;
}

const jobWait = defineJobTool({
	name: "job_wait",
	description:
		"Keep waiting for a job started earlier (exec, a call_tool call, or a subagent) and return its current result, " +
		"text like the tool that started it. With attention (default true) a subagent job returns at once when it " +
		"starts waiting for your decision; an approval or signature on an exec task or a call is the user's, so it " +
		"does not end the wait.",
	input: z.object({
		job_id: jobIdField,
		wait: z.number().int().min(0).max(600).optional().describe("Seconds to wait; the job keeps running after it"),
		attention: attentionField,
	}),
	readOnly: true,
	output: "text",
	handler: async (args, ctx) => {
		const jobs = jobsOf(ctx);
		const job = await jobForCaller(ctx, args.job_id);
		const seconds = Math.min(args.wait ?? ctx.defaultWaitS ?? 30, 600);
		const current = await jobs.waitJob(job, seconds, {
			attention: args.attention !== false,
			...(ctx.signal ? { signal: ctx.signal } : {}),
			ctx,
		});
		if (!current) throw new UserError("no such job", "no_such_job");
		return jobs.render(current, ctx);
	},
});

const jobCancel = defineJobTool({
	name: "job_cancel",
	description:
		"Cancel a job through the path of the work behind it: an exec task or task group, a call still waiting for " +
		"approval, or a subagent and its subtree. A settled job returns its current state instead.",
	input: z.object({
		job_id: jobIdField,
		reason: z.string().optional().describe("Why it is cancelled; shown where the record's cancel path keeps it"),
	}),
	readOnly: false,
	output: "json",
	handler: async (args, ctx) => {
		const jobs = jobsOf(ctx);
		const job = await jobForCaller(ctx, args.job_id);
		const result = await jobs.cancelJob(job, ctx.actor);
		if (!result.job) throw new UserError("no such job", "no_such_job");
		return jsonResult(jobStateOf(result.job, result.cancelled));
	},
});

const jobList = defineJobTool({
	name: "job_list",
	description:
		"List the jobs this caller started (this session, or this API token over MCP), newest first: id, kind, the " +
		"action line, state and outcome. Filter by state (`waiting`, `running` or `settled`).",
	input: z.object({
		state: z.enum(["waiting", "running", "settled"]).optional(),
	}),
	readOnly: true,
	output: "json",
	handler: async (args, ctx) => {
		const jobs = jobsOf(ctx);
		const rows = await jobs.list(ctx.actor, args.state);
		return jsonResult({ jobs: rows.map((row) => jobSummaryOf(row)) });
	},
});

function jobSummaryOf(job: JobRow): Record<string, unknown> {
	const outcome = outcomeOf(job);
	return {
		job_id: job.id,
		kind: job.kind,
		action: actionText(job),
		state: job.state,
		...(job.wait === null ? {} : { wait: job.wait }),
		...(outcome === undefined ? {} : { outcome }),
	};
}

function jobStateOf(job: JobRow, cancelSent: boolean): Record<string, unknown> {
	const outcome = outcomeOf(job);
	return {
		job_id: job.id,
		kind: job.kind,
		action: actionText(job),
		state: job.state,
		...(job.wait === null ? {} : { wait: job.wait }),
		...(outcome === undefined ? {} : { outcome }),
		cancel_sent: cancelSent,
	};
}

/** The same `define` shape the cluster catalog uses, without importing it at runtime. */
function defineJobTool<S extends z.ZodType>(tool: ClusterTool<S>): ClusterTool<S> {
	return tool;
}

export const JOB_TOOLS: readonly ClusterTool[] = [jobWait, jobCancel, jobList] as unknown as ClusterTool[];

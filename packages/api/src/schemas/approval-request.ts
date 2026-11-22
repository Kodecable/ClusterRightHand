/**
 * Runtime schemas for the one compact approval description every display surface renders
 * (`../approval-request.ts`, doc/design/access-control.md "Approvals"): the WebUI, Telegram and Satori all
 * read this model instead of building their own per-kind summaries.
 */
import { z } from "zod";
import { JobKindSchema } from "./jobs.ts";
import { ApprovalPhaseSchema, RuleSchema } from "./policy.ts";
import { RequestSourceSchema } from "./request-source.ts";
import { TaskActionSchema } from "./task-action.ts";

/** A candidate "always allow" rule, with the stable key its renderer labels. */
export const ApprovalAlwaysAllowSchema = z
	.object({
		option: z
			.enum(["exact", "prefix", "tool", "extension", "request", "route"])
			.describe(
				"A stable key: exact/prefix for tasks, tool/extension for an extension call, request/route for an API request.",
			),
		rule: RuleSchema,
	})
	.meta({ id: "ApprovalAlwaysAllow" });

/** The settled Auto Review verdict the user sees next to an escalated request. */
export const ApprovalReviewSummarySchema = z
	.object({ risk: z.enum(["low", "medium", "high"]), reason: z.string() })
	.meta({ id: "ApprovalReviewSummary" });

/**
 * The job a waiting request belongs to (doc/design/jobs.md "Approvals and jobs"): its id, kind and the same
 * structured action, so the decision panel and the approvals page can group one job's approvals and describe
 * them in the background bar's words.
 */
export const ApprovalRequestJobSchema = z
	.object({ id: z.string(), kind: JobKindSchema, action: TaskActionSchema })
	.meta({ id: "ApprovalRequestJob" });

/**
 * One waiting approval, small and locale-free: who asks, what waits, where, how risky the review judged
 * it and the rules an "always allow" would add. Details stay on the task, task group and external call pages.
 * `phase` is `reviewing` only while Auto Review is still judging; such a request is not shown as a user wait.
 * A task or task group waiting for a signature is `awaiting_signature`.
 */
export const ApprovalRequestSchema = z
	.object({
		kind: z.enum(["task", "task_group", "external_call"]),
		id: z.string(),
		phase: ApprovalPhaseSchema,
		source: RequestSourceSchema,
		action: TaskActionSchema,
		nodes: z.array(z.string()).optional().describe("Node names, capped; absent when the operation has no node."),
		moreNodes: z.number().optional().describe("How many more nodes a capped `nodes` list leaves out."),
		privileged: z.boolean(),
		review: ApprovalReviewSummarySchema.optional().describe("Absent while reviewing or when no review ran."),
		job: ApprovalRequestJobSchema.optional().describe("The job the waiting record belongs to, when it belongs to one."),
		alwaysAllow: z
			.array(ApprovalAlwaysAllowSchema)
			.describe("The server-built always-allow candidates, in display order."),
	})
	.meta({ id: "ApprovalRequest", description: "One waiting approval, ready for any display surface to render." });

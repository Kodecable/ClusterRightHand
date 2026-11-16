/**
 * Runtime schemas for the one compact approval description every display surface renders
 * (`../approval-request.ts`, doc/design/access-control.md "Approvals"): the WebUI, Telegram and Satori all
 * read this model instead of building their own per-kind summaries.
 */
import { z } from "zod";
import { ApprovalPhaseSchema, RuleSchema } from "./policy.ts";

/** Who asked for the waiting operation. A subagent's request resolves to its root session. */
export const ApprovalRequesterSchema = z
	.discriminatedUnion("type", [
		z.object({
			type: z.literal("session"),
			sessionId: z.string().describe("The root session's id."),
			title: z
				.string()
				.describe("The stored title; empty when the session has none, so the renderer uses its untitled name."),
		}),
		z.object({ type: z.literal("api_token"), tokenId: z.string(), name: z.string() }),
		z.object({ type: z.literal("user"), userId: z.string(), username: z.string() }),
		z.object({ type: z.literal("schedule"), scheduleId: z.string(), name: z.string() }),
	])
	.meta({ id: "ApprovalRequester" });

/** What waits, as data rather than prose. */
export const ApprovalActionSchema = z
	.discriminatedUnion("type", [
		z.object({
			type: z.literal("exec"),
			command: z.string().describe("The command line, shell-quoted for argv and clipped to 300 characters."),
		}),
		z.object({
			type: z.literal("file"),
			operation: z.enum(["read", "write", "push", "pull", "edit", "stat", "list"]),
			path: z.string(),
			lines: z.object({ start: z.number(), end: z.number() }).optional(),
		}),
		z.object({ type: z.literal("api_request"), method: z.string(), path: z.string() }),
		z.object({ type: z.literal("extension_tool"), extension: z.string(), tool: z.string() }),
	])
	.meta({ id: "ApprovalAction" });

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
 * One waiting approval, small and locale-free: who asks, what waits, where, how risky the review judged
 * it and the rules an "always allow" would add. Details stay on the task, task group and external call pages.
 * `phase` is `reviewing` only while Auto Review is still judging; such a request is not shown as a user wait.
 */
export const ApprovalRequestSchema = z
	.object({
		kind: z.enum(["task", "task_group", "external_call"]),
		id: z.string(),
		phase: ApprovalPhaseSchema,
		requester: ApprovalRequesterSchema,
		action: ApprovalActionSchema,
		nodes: z.array(z.string()).optional().describe("Node names, capped; absent when the operation has no node."),
		moreNodes: z.number().optional().describe("How many more nodes a capped `nodes` list leaves out."),
		privileged: z.boolean(),
		review: ApprovalReviewSummarySchema.optional().describe("Absent while reviewing or when no review ran."),
		alwaysAllow: z
			.array(ApprovalAlwaysAllowSchema)
			.describe("The server-built always-allow candidates, in display order."),
	})
	.meta({ id: "ApprovalRequest", description: "One waiting approval, ready for any display surface to render." });

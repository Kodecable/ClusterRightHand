/**
 * Runtime schemas for jobs (doc/design/jobs.md "Job model" and "API"): the model's handle on work a tool call
 * started, and the wire shape the WebUI's background bar, its tool rows and the session event stream read.
 * A job is a projection of a task, task group, external call or subagent session; the resource reference is
 * the page a row links to.
 */
import { z } from "zod";
import { cursorPageSchema, IdParamSchema } from "./common.ts";
import { TaskActionSchema } from "./task-action.ts";
import { TaskOutcomeSchema } from "./task-outcome.ts";

/** What runs behind a job: a task or task group, an external call, or a subagent's session. */
export const JobKindSchema = z.enum(["exec", "call", "subagent"]).meta({
	id: "JobKind",
	description: "The kind of work a job follows: an exec task, an external call or a subagent.",
});

/** The one state vocabulary every kind projects to (doc/design/jobs.md "States"). */
export const JobStateSchema = z
	.enum(["waiting", "running", "settled"])
	.meta({ id: "JobState", description: "Waiting for approval, signature, quota or a decision; running; or settled." });

/** What a waiting job waits for; derived from the same fields the decision panel reads. */
export const JobWaitSchema = z
	.enum(["approval", "signature", "quota", "decision"])
	.meta({ id: "JobWait", description: "What a waiting job waits for; null while it is not waiting." });

/** The record a job projects: the page its row links to (an external call has none). */
export const JobResourceSchema = z
	.object({
		type: z.enum(["task", "task_group", "external_call", "session"]),
		id: z.string(),
	})
	.meta({
		id: "JobResource",
		description:
			"The record behind a job and its id; a task or task group id, an external call id or a subagent session id.",
	});

/**
 * One job as the API serves it (doc/design/jobs.md "API"): the id the model waits with, the projected state,
 * the structured action approvals also show, the record it projects and its times. It carries no output.
 */
export const JobViewSchema = z
	.object({
		id: z.string().describe("The job id, `<kind>-<hex>`."),
		kind: JobKindSchema,
		state: JobStateSchema,
		wait: JobWaitSchema.nullable().describe("What it waits for while it is waiting; null otherwise."),
		outcome: TaskOutcomeSchema.nullable().describe("The outcome once it has settled; null before."),
		action: TaskActionSchema,
		sessionId: z.string().nullable().describe("The session whose tool call started it; null for an MCP client."),
		resource: JobResourceSchema,
		createdAt: z.string(),
		settledAt: z.string().nullable().describe("When it settled; null while it is unsettled."),
	})
	.meta({ id: "JobView", description: "One job, ready for the WebUI to render and link." });

/** `GET /api/jobs?session=…` filters; query values are strings. */
export const JobListQuerySchema = z.object({
	session: z.string().describe("The session whose jobs to list; its owner and share viewers may read them."),
	active: z
		.enum(["true", "1", "false", "0"])
		.optional()
		.describe("Only waiting and running jobs (true/1), so the background bar never loads settled ones."),
	cursor: z.string().optional().describe("The `nextCursor` of the previous page."),
	limit: z.string().optional().describe("Page size, 1 to 200; 50 by default."),
});

/** One page of a session's jobs, newest first. */
export const JobPageResponseSchema = cursorPageSchema(JobViewSchema).meta({ id: "JobPageResponse" });

/** `GET /api/jobs/:id`. */
export const JobResponseSchema = z.object({ job: JobViewSchema }).meta({ id: "JobResponse" });

/** `POST /api/jobs/:id/cancel`: whether the record's cancel path accepted it, and the job after it. */
export const JobCancelResponseSchema = z
	.object({
		cancelled: z.boolean().describe("Whether a running or waiting record was cancelled."),
		job: JobViewSchema,
	})
	.meta({ id: "JobCancelResponse" });

/** Path parameter of the job routes. */
export const JobIdParamSchema = IdParamSchema;

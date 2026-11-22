/**
 * Runtime schema for the one compact, locale-free job description every display surface renders
 * (doc/design/jobs.md "Completion notices" and "Display"): the WebUI's notice line and the chat channels'
 * line read this model instead of the entry's model-facing text.
 */
import { z } from "zod";
import { JobResourceSchema } from "./jobs.ts";
import { TaskActionSchema } from "./task-action.ts";
import { TaskOutcomeSchema } from "./task-outcome.ts";

/**
 * One finished job a completion notice names: the job id the model waits with, its kind, the action it did and
 * how it ended. `woke` says the notice was placed as an input that started the agent's run. `resource` is the
 * record behind the job, so a display surface can link the line to its page; an external call has none. It
 * carries no output: that is read with `job_wait`, as a tool result.
 */
export const JobNoticeSchema = z
	.object({
		jobId: z.string(),
		kind: z.enum(["exec", "call", "subagent"]),
		action: TaskActionSchema,
		outcome: TaskOutcomeSchema,
		woke: z.boolean().describe("The notice was placed as an input that started the agent's run."),
		resource: JobResourceSchema.optional().describe("The job's record, when it has a page to link to."),
	})
	.meta({ id: "JobNotice", description: "One finished job, ready for any display surface to render." });

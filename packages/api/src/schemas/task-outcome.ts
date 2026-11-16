/**
 * A task's or task group's classified outcome (`../task-outcome.ts`, doc/design/execution.md "State
 * machine"). The server computes it once from the stored row, so every surface colours and words the
 * same result identically; it is null while the task is not terminal.
 */
import { z } from "zod";

export const TaskOutcomeKindSchema = z.enum([
	"succeeded",
	"exit",
	"signal",
	"timed_out",
	"cancelled",
	"expired",
	"rejected",
	"denied",
	"error",
	"unknown",
]);

export const TaskOutcomeSchema = z
	.object({
		kind: TaskOutcomeKindSchema,
		failed: z
			.boolean()
			.describe("Whether the result counts as a failure; a cancellation or an expired signature wait does not."),
		exitCode: z.number().optional().describe("The exit code when one decides the outcome; exec keeps exit 0."),
		signal: z.string().optional(),
		errorCode: z.string().nullable().optional(),
		errorMessage: z.string().nullable().optional(),
	})
	.meta({ id: "TaskOutcome", description: "One terminal result, classified the same way for every surface." });

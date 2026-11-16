/**
 * What a task or a waiting approval does, as data rather than prose (`../task-action.ts`,
 * doc/design/webui.md "Shared components"). One server function builds it from the task spec, and every
 * surface renders this model instead of parsing the spec itself.
 */
import { z } from "zod";

export const TaskActionSchema = z
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
	.meta({ id: "TaskAction", description: "What a task or a waiting approval does, ready for display." });

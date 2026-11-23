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
		z.object({
			type: z.literal("upgrade"),
			version: z.string().describe("The crha version the node is upgraded to."),
			arch: z.string(),
		}),
		z.object({ type: z.literal("api_request"), method: z.string(), path: z.string() }),
		z.object({ type: z.literal("extension_tool"), extension: z.string(), tool: z.string() }),
		z.object({
			type: z.literal("subagent"),
			task: z.string().describe("The task's first line, clipped to 300 characters."),
		}),
		z.object({
			type: z.literal("pty.create"),
			argv: z.array(z.string()).describe("The command the terminal would run; empty runs the login shell."),
		}),
		z.object({
			type: z.literal("pty.io"),
			input: z.string().nullable().describe("The text the agent would type, clipped."),
			keys: z.array(z.string()).describe("The named keys the agent would send, such as Enter or Ctrl-C."),
			screen: z.string().describe("The terminal's screen when the request was made, clipped."),
		}),
	])
	.meta({ id: "TaskAction", description: "What a task or a waiting approval does, ready for display." });

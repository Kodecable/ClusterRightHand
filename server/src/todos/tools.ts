/**
 * `todo_write` (doc/design/todo.md "The tool"): the root session agent's whole-list replacement. A subagent
 * works on one delegated task, so its parent's list covers it; a call without a root session is refused.
 */
import type { TodoItem } from "@crh/api";
import * as z from "zod/v4";
import type { ClusterTool, ToolContext } from "../tools/catalog.ts";
import { UserError } from "../util/errors.ts";
import { textResult } from "../util/tool-result.ts";
import { MAX_TODO_CONTENT_CHARS, MAX_TODO_ITEMS, todosJson } from "./todos.ts";

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** Everything a one-line todo must not hold: whitespace and control characters (Unicode category Cc). */
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]+/gu;

const todoItemField = z.object({
	content: z
		.string()
		.describe(
			`One short imperative line: whitespace and control characters collapse to single spaces; trimmed, ` +
				`non-empty, unique in the list and at most ${MAX_TODO_CONTENT_CHARS} characters`,
		),
	status: z.enum(["pending", "in_progress", "completed"]).describe("Where this step stands"),
});

const todoWrite = {
	name: "todo_write",
	description:
		"Record and update a task list to plan multi-step work and show the owner your progress; skip it for a " +
		"single quick step. Before you start, add one todo per concrete step. Keep the todos being worked on " +
		"`in_progress`, several only when work runs in parallel (for example background jobs), and mark each one " +
		"`completed` as soon as it is done. The list stays until you replace it: when you start unrelated work, " +
		"write a new list, and write an empty list when nothing is left to track.",
	input: z.object({
		todos: z
			.array(todoItemField)
			.describe(
				"The complete list, replacing the previous one; an empty array clears it. At most " +
					`${MAX_TODO_ITEMS} items.`,
			),
	}),
	readOnly: false,
	agentOnly: true,
	output: "text",
	handler: async (args: { todos: { content: string; status: string }[] }, ctx: ToolContext) => {
		const session = await rootSession(ctx);
		const todos = checkedTodos(args);
		// Policy treats it like job_list: no approval, it changes nothing outside the session. The tool is
		// idempotent, because the same list written twice is the same row value.
		if (ctx.todos) await ctx.todos.replace(ctx.db, session, todos);
		else await directWrite(ctx, session, todos);
		const pending = todos.filter((todo) => todo.status === "pending").length;
		const inProgress = todos.filter((todo) => todo.status === "in_progress").length;
		const completed = todos.filter((todo) => todo.status === "completed").length;
		return textResult([
			{ output: `Updated todo list: ${pending} pending, ${inProgress} in progress, ${completed} completed.` },
		]);
	},
} as unknown as ClusterTool;

/** Refuses every caller without a root session: a subagent, an MCP client or a missing row. */
async function rootSession(ctx: ToolContext): Promise<string> {
	if (ctx.actor.type !== "session") {
		throw new UserError("todo_write is available in a root session only", "root_session_only");
	}
	const row = await ctx.db
		.selectFrom("sessions")
		.select(["id", "parent_session_id"])
		.where("id", "=", ctx.actor.id)
		.executeTakeFirst();
	if (!row || row.parent_session_id !== null) {
		throw new UserError("todo_write is available in a root session only", "root_session_only");
	}
	return row.id;
}

/**
 * Every rule the doc names, in one place, so the model gets the rule it broke and nothing is stored. Content is
 * normalized first: the block, the bar and the list render one item per line, so a newline or another control
 * character could forge an extra `[status]` line or the block's closing tag.
 */
function checkedTodos(args: { todos: { content: string; status: string }[] }): TodoItem[] {
	if (!Array.isArray(args.todos)) throw new UserError("todos must be an array", "invalid_todo");
	if (args.todos.length > MAX_TODO_ITEMS) {
		throw new UserError(`the todo list holds at most ${MAX_TODO_ITEMS} items`, "invalid_todo");
	}
	const seen = new Set<string>();
	const todos: TodoItem[] = [];
	for (const item of args.todos) {
		if (typeof item !== "object" || item === null || typeof item.content !== "string") {
			throw new UserError("every todo needs a content string", "invalid_todo");
		}
		const content = oneLine(item.content);
		if (content === "") throw new UserError("todo content must not be empty", "invalid_todo");
		if (Array.from(content).length > MAX_TODO_CONTENT_CHARS) {
			throw new UserError(`todo content must be at most ${MAX_TODO_CONTENT_CHARS} characters`, "invalid_todo");
		}
		if (seen.has(content)) throw new UserError(`todo content must be unique: ${content}`, "invalid_todo");
		if (!STATUSES.has(item.status)) {
			throw new UserError("todo status must be pending, in_progress or completed", "invalid_todo");
		}
		seen.add(content);
		todos.push({ content, status: item.status as TodoItem["status"] });
	}
	return todos;
}

/** One line: every run of whitespace and control characters becomes one space, then the ends are trimmed. */
function oneLine(content: string): string {
	return content.replace(WHITESPACE_OR_CONTROL, " ").trim();
}

/** The path when no change bus was supplied (a direct tool call in a test or a tool surface without a runtime). */
async function directWrite(ctx: ToolContext, sessionId: string, todos: readonly TodoItem[]): Promise<void> {
	await ctx.db
		.updateTable("sessions")
		.set({ todos: todosJson(todos) })
		.where("id", "=", sessionId)
		.execute();
}

export const TODO_TOOLS: readonly ClusterTool[] = [todoWrite];

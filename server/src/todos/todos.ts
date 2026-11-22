/**
 * A root session's todo list (doc/design/todo.md): session state, not conversation history. The agent replaces
 * the whole list with `todo_write`; the row holds the current list and the column is the fast read for the
 * WebUI and the compaction summary.
 *
 * `TodoLists` is also the change bus: the tool writes through it, and the session event stream forwards every
 * write as `todo.changed`. It is deliberately independent of SQLite/PostgreSQL specifics.
 */
import type { TodoItem } from "@crh/api";
import type { Db } from "../storage/db.ts";

/** The most items one list may hold. */
export const MAX_TODO_ITEMS = 50;
/** The longest one item's content may be, counted in Unicode code points. */
export const MAX_TODO_CONTENT_CHARS = 200;

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** The stored JSON as a list; null when the session has no list and for an unreadable value. */
export function parseStoredTodos(json: string | null): TodoItem[] | null {
	if (json === null || json.trim() === "") return null;
	try {
		const value = JSON.parse(json) as unknown;
		if (!Array.isArray(value)) return null;
		const todos: TodoItem[] = [];
		for (const item of value) {
			if (typeof item !== "object" || item === null) return null;
			const record = item as Record<string, unknown>;
			if (typeof record.content !== "string" || typeof record.status !== "string") return null;
			if (!STATUSES.has(record.status)) return null;
			todos.push({ content: record.content, status: record.status as TodoItem["status"] });
		}
		return todos.length === 0 ? null : todos;
	} catch {
		return null;
	}
}

/** The column value for a list: JSON, and null for an empty list (a cleared list). */
export function todosJson(todos: readonly TodoItem[]): string | null {
	return todos.length === 0 ? null : JSON.stringify(todos);
}

/** The request-only block a compaction summary gets (doc/design/todo.md "Compaction"); empty for an empty list. */
export function todoBlock(todos: readonly TodoItem[] | null): string | undefined {
	if (todos === null || todos.length === 0) return undefined;
	const lines = todos.map((todo) => `[${todo.status}] ${todo.content}`);
	return `<todo_list at_compaction="true">\n${lines.join("\n")}\n</todo_list>`;
}

/**
 * The session list changes travel as events (doc/design/todo.md "API"). The tool layer stays free of the API
 * layer: listeners receive the session id and the normalized list.
 */
export class TodoLists {
	readonly #listeners = new Set<(sessionId: string, todos: TodoItem[] | null) => void>();

	/** Subscribes to list replacements; the returned function unsubscribes. */
	onChanged(listener: (sessionId: string, todos: TodoItem[] | null) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Replaces the list and publishes it. An empty list clears the column to null. */
	async replace(db: Db, sessionId: string, todos: readonly TodoItem[]): Promise<void> {
		const normalized = todos.length === 0 ? null : [...todos];
		await db
			.updateTable("sessions")
			.set({ todos: todosJson(todos) })
			.where("id", "=", sessionId)
			.execute();
		for (const listener of this.#listeners) listener(sessionId, normalized);
	}
}

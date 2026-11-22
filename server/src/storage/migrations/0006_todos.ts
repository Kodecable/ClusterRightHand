import type { Kysely } from "kysely";

/**
 * A root session's todo list (doc/design/todo.md "Storage"): the current list as JSON, null when the session
 * never had one or the list was cleared. `todos_at_compaction` freezes the list when a compaction is planned,
 * so every later request appends the same block to the summary message; a later compaction replaces it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").addColumn("todos", "text").execute();
	await db.schema.alterTable("sessions").addColumn("todos_at_compaction", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("todos_at_compaction").execute();
	await db.schema.alterTable("sessions").dropColumn("todos").execute();
}

import type { Kysely } from "kysely";

/**
 * A task's structured result (doc/design/protocol.md "Task results"): the typed result a `file.read`,
 * `file.stat`, `file.list`, `file.write` or `file.edit` task reports in `task.exit`, stored in its
 * JSON form. It is nullable because a task may report none, and it is text like the spec: both
 * dialects store JSON as text.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").addColumn("result", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").dropColumn("result").execute();
}

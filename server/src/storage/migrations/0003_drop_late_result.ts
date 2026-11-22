import type { Kysely } from "kysely";

/**
 * A late result is recorded in the normal result columns of an `unknown` task (exit code, signal,
 * timeout, structured result and output) and shown with it, so the separate JSON column is gone
 * (doc/design/execution.md "Reconnect").
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").dropColumn("late_result").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").addColumn("late_result", "text").execute();
}

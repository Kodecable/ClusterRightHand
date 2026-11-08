import type { Kysely } from "kysely";

/**
 * D118: a task row has a version. Every write to `tasks` bumps `rev`; a write whose decision came from an
 * earlier read names the `rev` it read, so a row changed in between is left alone instead of being
 * overwritten with the older decision. The column is additive with a zero default, so SQLite and
 * PostgreSQL both add it in place and every existing row starts at version 0.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("tasks")
		.addColumn("rev", "integer", (column) => column.notNull().defaultTo(0))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").dropColumn("rev").execute();
}

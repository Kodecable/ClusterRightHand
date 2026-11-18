import type { Kysely } from "kysely";

/**
 * Whether crha lost buffered output before the task exited (doc/design/execution.md "Output"). The
 * task keeps only the output prefix before the loss, so every surface can mark it as incomplete.
 * Existing rows default to 0: output was not known to be lost.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("tasks")
		.addColumn("output_lost", "integer", (c) => c.notNull().defaultTo(0))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").dropColumn("output_lost").execute();
}

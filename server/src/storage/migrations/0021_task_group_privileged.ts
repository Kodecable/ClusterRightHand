import type { Kysely } from "kysely";

/**
 * Privileged task groups (doc/m4.md M4.1, D86): the flag stays on the group too, so approving a group
 * and then creating its tasks keeps it, and a task waiting for approval is re-judged with it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("task_groups")
		.addColumn("privileged", "integer", (c) => c.notNull().defaultTo(0))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("task_groups").dropColumn("privileged").execute();
}

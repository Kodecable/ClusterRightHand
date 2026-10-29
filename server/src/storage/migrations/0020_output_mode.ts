import type { Kysely } from "kysely";

/**
 * Batch output modes (doc/execution-plane.md#输出): a single task keeps the full head and tail (`full`), a
 * batch `text` task keeps one combined per-node tail within the group budget, and a `status` task keeps
 * nothing but the exit and the node's output file. Existing groups were all `text`; new groups are created
 * as `status` by the code.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("tasks")
		.addColumn("output_mode", "text", (c) => c.notNull().defaultTo("full"))
		.execute();
	await db.schema
		.alterTable("task_groups")
		.addColumn("output_mode", "text", (c) => c.notNull().defaultTo("text"))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("task_groups").dropColumn("output_mode").execute();
	await db.schema.alterTable("tasks").dropColumn("output_mode").execute();
}

import type { Kysely } from "kysely";

/**
 * The output budgets and the merged tail. A task group may cap each of its nodes' kept output
 * with `node_max_lines` / `node_max_bytes`; every member task copies those caps into its own
 * `max_lines` / `max_bytes`, which also cap a single task's merged tail. `tasks.output_tail` stores
 * the merged stdout+stderr tail of a single task, and `tasks.output_lines` the total line count
 * crha reports in `task.exit` (counted by crhs for SSH nodes).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("task_groups").addColumn("node_max_lines", "integer").execute();
	await db.schema.alterTable("task_groups").addColumn("node_max_bytes", "integer").execute();
	await db.schema.alterTable("tasks").addColumn("max_lines", "integer").execute();
	await db.schema.alterTable("tasks").addColumn("max_bytes", "integer").execute();
	await db.schema.alterTable("tasks").addColumn("output_tail", "text").execute();
	await db.schema.alterTable("tasks").addColumn("output_lines", "integer").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").dropColumn("output_lines").execute();
	await db.schema.alterTable("tasks").dropColumn("output_tail").execute();
	await db.schema.alterTable("tasks").dropColumn("max_bytes").execute();
	await db.schema.alterTable("tasks").dropColumn("max_lines").execute();
	await db.schema.alterTable("task_groups").dropColumn("node_max_bytes").execute();
	await db.schema.alterTable("task_groups").dropColumn("node_max_lines").execute();
}

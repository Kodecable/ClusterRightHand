import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("tasks")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		// No foreign key: tasks outlive deleted nodes for the record.
		.addColumn("node_id", "text", (c) => c.notNull())
		.addColumn("task_group_id", "text")
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("spec", "text", (c) => c.notNull())
		.addColumn("input_size", "integer")
		.addColumn("input_sha256", "text")
		.addColumn("privileged", "integer", (c) => c.notNull())
		.addColumn("timeout_ms", "integer")
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("exit_code", "integer")
		.addColumn("signal", "text")
		.addColumn("timed_out", "integer", (c) => c.notNull())
		.addColumn("cancelled", "integer", (c) => c.notNull())
		.addColumn("error_code", "text")
		.addColumn("error_message", "text")
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("dispatched_at", "text")
		.addColumn("accepted_at", "text")
		.addColumn("finished_at", "text")
		.addColumn("stdout_bytes", "bigint", (c) => c.notNull())
		.addColumn("stderr_bytes", "bigint", (c) => c.notNull())
		// Base64; see doc/design/execution.md "Output" (crhs keeps only head and tail).
		.addColumn("stdout_head", "text")
		.addColumn("stdout_tail", "text")
		.addColumn("stderr_head", "text")
		.addColumn("stderr_tail", "text")
		.addColumn("output_file", "text")
		// A result that arrived after the task had been reported unknown.
		.addColumn("late_result", "text")
		.execute();
	await db.schema.createIndex("tasks_node_state_idx").on("tasks").columns(["node_id", "state"]).execute();
	await db.schema.createIndex("tasks_group_idx").on("tasks").column("task_group_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("tasks").execute();
}

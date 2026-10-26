import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("task_groups")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		// What the caller asked for (node names and group:<name>), and what it resolved to.
		.addColumn("targets", "text", (c) => c.notNull())
		.addColumn("node_ids", "text", (c) => c.notNull())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("parallel", "integer", (c) => c.notNull())
		.addColumn("fail_fast", "integer", (c) => c.notNull())
		// Node ids never started because of fail_fast or an interruption.
		.addColumn("skipped", "text", (c) => c.notNull())
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("finished_at", "text")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("task_groups").execute();
}

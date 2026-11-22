import type { Kysely } from "kysely";

/**
 * Jobs (doc/design/jobs.md "Job model"): one row per tool call that may outlive its invocation, whichever
 * kind of work it started. The row is a projection of the task, external call or child session behind it; the
 * adapters read those records and never write them. `call_key` is the durable tool call key, so a replayed
 * tool call finds the job its first attempt created.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("jobs")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text", (c) => c.notNull())
		.addColumn("session_id", "text", (c) => c.references("sessions.id").onDelete("cascade"))
		.addColumn("call_key", "text", (c) => c.notNull().unique())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("resource_type", "text", (c) => c.notNull())
		.addColumn("resource_id", "text", (c) => c.notNull())
		.addColumn("action", "text", (c) => c.notNull())
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("outcome", "text")
		.addColumn("wait", "text")
		.addColumn("result", "text")
		.addColumn("notice", "text", (c) => c.notNull().defaultTo("none"))
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("settled_at", "text")
		.execute();
	await db.schema.createIndex("jobs_session_state_idx").on("jobs").columns(["session_id", "state"]).execute();
	await db.schema.createIndex("jobs_resource_idx").on("jobs").columns(["resource_type", "resource_id"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("jobs").execute();
}

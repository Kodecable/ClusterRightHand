import type { Kysely } from "kysely";

/**
 * A paused tool call asking for more token quota (doc/agent-runtime.md#配额). `level_id` is the exhausted level
 * to top up; `handler_session_id` is the ancestor session whose agent decides, or null for the owner.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("quota_requests")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("session_id", "text", (c) => c.notNull())
		.addColumn("level_id", "text", (c) => c.notNull())
		.addColumn("handler_session_id", "text")
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("granted_tokens", "integer")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("resolved_at", "text")
		.execute();
	await db.schema
		.createIndex("quota_requests_handler_idx")
		.on("quota_requests")
		.columns(["handler_session_id", "state"])
		.execute();
	await db.schema
		.createIndex("quota_requests_session_idx")
		.on("quota_requests")
		.columns(["session_id", "state"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("quota_requests").execute();
}

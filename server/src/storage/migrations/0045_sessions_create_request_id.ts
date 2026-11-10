import type { Kysely } from "kysely";

/**
 * Creating a session and submitting its first message is one request, deduplicated by a client-generated
 * request id. `create_request_id` is null for every session not created by such a request (subagents, scheduled
 * runs, sessions created through the runtime). The unique index is per owner; SQLite and PostgreSQL both allow
 * any number of nulls in a unique index, so only a real request id is deduplicated.
 *
 * Additive: SQLite can add the column and the index in place, so no table rebuild is needed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").addColumn("create_request_id", "text").execute();
	await db.schema
		.createIndex("sessions_owner_create_request_unique")
		.on("sessions")
		.columns(["owner_user_id", "create_request_id"])
		.unique()
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("sessions_owner_create_request_unique").execute();
	await db.schema.alterTable("sessions").dropColumn("create_request_id").execute();
}

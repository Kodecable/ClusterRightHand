import type { Kysely } from "kysely";

/**
 * The session list's keyset pages (doc/design/webui.md "Session list API"): `scope=mine` filters the owner, `scope=all`
 * filters only the missing parent, and both order by `updated_at DESC, id DESC`. Each index carries the
 * filter columns first so SQLite and PostgreSQL can walk it in order instead of sorting every root session.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("sessions_owner_parent_updated_idx")
		.on("sessions")
		.columns(["owner_user_id", "parent_session_id", "updated_at", "id"])
		.execute();
	await db.schema
		.createIndex("sessions_parent_updated_idx")
		.on("sessions")
		.columns(["parent_session_id", "updated_at", "id"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("sessions_parent_updated_idx").on("sessions").execute();
	await db.schema.dropIndex("sessions_owner_parent_updated_idx").on("sessions").execute();
}

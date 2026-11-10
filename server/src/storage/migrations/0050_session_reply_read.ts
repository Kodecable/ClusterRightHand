import type { Kysely } from "kysely";

/**
 * Unread sessions (doc/design/webui.md "Sidebar list"): a root's `reply_at` is when its tree last produced new output for
 * the owner (its aggregate state left `running` for `idle` or `awaiting`), and `owner_read_at` is when the
 * owner last opened the tree. Both are ISO timestamps and only roots use them; `unread` is computed for the
 * owner alone, so a shared viewer never sees another user's read state.
 *
 * Additive: SQLite can add the nullable columns in place, so no table rebuild is needed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").addColumn("reply_at", "text").execute();
	await db.schema.alterTable("sessions").addColumn("owner_read_at", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("owner_read_at").execute();
	await db.schema.alterTable("sessions").dropColumn("reply_at").execute();
}

import type { Kysely } from "kysely";

/**
 * A subagent's state belongs on the session, not in a separate request table (doc/design/agent-runtime.md "Subagents"):
 * `active`, `awaiting_quota` (paused on an exhausted quota level), or `stopped`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("sessions")
		.addColumn("state", "text", (c) => c.notNull().defaultTo("active"))
		.execute();
	await db.schema.alterTable("sessions").addColumn("waiting_level_id", "text").execute();
	await db.schema.alterTable("sessions").addColumn("state_changed_at", "text").execute();
	// Carry pending quota waits over to the session state, then drop the old request table.
	// biome-ignore lint/suspicious/noExplicitAny: migration reads the table it is replacing
	const d = db as Kysely<any>;
	const waiting = await d
		.selectFrom("quota_requests")
		.select(["session_id", "level_id", "created_at"])
		.where("state", "=", "pending")
		.orderBy("created_at", "desc")
		.execute();
	const seen = new Set<string>();
	for (const row of waiting) {
		if (seen.has(row.session_id)) continue;
		seen.add(row.session_id);
		await d
			.updateTable("sessions")
			.set({ state: "awaiting_quota", waiting_level_id: row.level_id, state_changed_at: row.created_at })
			.where("id", "=", row.session_id)
			.execute();
	}
	await db.schema.dropTable("quota_requests").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
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
	await db.schema.alterTable("sessions").dropColumn("state_changed_at").execute();
	await db.schema.alterTable("sessions").dropColumn("waiting_level_id").execute();
	await db.schema.alterTable("sessions").dropColumn("state").execute();
}

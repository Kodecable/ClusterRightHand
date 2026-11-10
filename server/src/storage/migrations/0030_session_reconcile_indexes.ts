import { type Kysely, type SqlBool, sql } from "kysely";

/**
 * Indexes for the startup reconciliation's two candidate queries (agent/runtime-state.ts `reconcileSessionStates`,
 * doc/design/agent-runtime.md "Session state"):
 * - candidate 1 selects every session whose row is not `idle`: a partial index on the non-idle rows keeps
 *   that lookup proportional to the sessions that claim a live run or a wait, not to the whole (mostly idle)
 *   table of doc/design/webui.md's 100,000 sessions;
 * - candidate 2 maps durable's unsettled submission ids back to their sessions through `last_submission_id`.
 *
 * Both SQLite and PostgreSQL support partial indexes; the predicate is the literal `state <> 'idle'` the
 * candidate query uses, so each dialect can prove that a query needs only the index's rows.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("sessions_state_live_idx")
		.on("sessions")
		.column("state")
		.where(sql<SqlBool>`state <> 'idle'`)
		.execute();
	await db.schema.createIndex("sessions_last_submission_idx").on("sessions").column("last_submission_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("sessions_last_submission_idx").on("sessions").execute();
	await db.schema.dropIndex("sessions_state_live_idx").on("sessions").execute();
}

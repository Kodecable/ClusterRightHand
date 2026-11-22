import type { Kysely } from "kysely";

/**
 * The completion-notice wake counter of a session (doc/design/jobs.md "Completion notices"): how many times the
 * session has been woken by `crh.notice` inputs since the last user-authored message. It caps a self-exciting
 * chain (`jobs.max_consecutive_wakes`), so the count lives in the row and survives a restart instead of resetting.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.alterTable("sessions")
		.addColumn("notice_wakes", "integer", (c) => c.notNull().defaultTo(0))
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("notice_wakes").execute();
}

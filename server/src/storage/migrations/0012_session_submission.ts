import type { Kysely } from "kysely";

/**
 * The last input submitted to the session's conversation, so a parent can wait for a subagent's answer after a
 * restart or after its foreground wait was interrupted (doc/agent-runtime.md#处理子会话的请求).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").addColumn("last_submission_id", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("last_submission_id").execute();
}

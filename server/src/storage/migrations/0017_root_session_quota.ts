import type { Kysely } from "kysely";

/**
 * Root sessions have no quota (0) and are never charged. Sessions that predate the token-quota migration
 * could still carry null or a budget-derived remainder; normalize them so the data matches the rule.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration on the sessions table
	const d = db as Kysely<any>;
	await d.updateTable("sessions").set({ quota_tokens: 0 }).where("parent_session_id", "is", null).execute();
}

export async function down(): Promise<void> {
	// The previous values cannot be reconstructed; roots are never charged either way.
}

import type { Kysely } from "kysely";

/**
 * Any level may have a quota and a root without one is unlimited (D92): before this, a root session's quota was
 * pinned to 0 and never charged. A 0 made every root look exhausted, so every such root becomes null (unlimited
 * and not charged). Subagent quotas are unchanged: 0 there still means "used up".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// biome-ignore lint/suspicious/noExplicitAny: data migration on the sessions table
	const d = db as Kysely<any>;
	await d
		.updateTable("sessions")
		.set({ quota_tokens: null })
		.where("parent_session_id", "is", null)
		.where("quota_tokens", "=", 0)
		.execute();
}

export async function down(): Promise<void> {
	// A root with null may have been unlimited all along, so 0 cannot be put back without changing its meaning.
}

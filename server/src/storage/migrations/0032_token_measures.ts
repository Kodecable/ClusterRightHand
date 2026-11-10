import type { Kysely } from "kysely";

/**
 * Two token measures kept apart by name (doc/design/agent-runtime.md "Quota and token accounting"):
 *
 * - `budget_used_tokens`: the budget measure, renamed from `used_tokens`. Output tokens of every model call,
 *   compaction and review included; it decides when a quota level stops a run.
 * - `usage_tokens`: the statistics measure. Input + output tokens of every model call, cache included in the
 *   input, accumulated up the session tree.
 * - `context_tokens`: the input size (input + cache read + cache write) of the session's own last main-agent
 *   model call; null before the first one.
 *
 * Existing counters keep their values: the budget measure is unchanged, and `usage_tokens` starts at 0. The
 * runtime backfills it from durable's per-conversation usage at the next start (usage-backfill.ts), which is
 * where the persisted calls can still be read.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").renameColumn("used_tokens", "budget_used_tokens").execute();
	await db.schema
		.alterTable("sessions")
		.addColumn("usage_tokens", "bigint", (col) => col.notNull().defaultTo(0))
		.execute();
	await db.schema.alterTable("sessions").addColumn("context_tokens", "bigint").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("context_tokens").execute();
	await db.schema.alterTable("sessions").dropColumn("usage_tokens").execute();
	await db.schema.alterTable("sessions").renameColumn("budget_used_tokens", "used_tokens").execute();
}

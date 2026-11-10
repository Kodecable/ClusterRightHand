import type { Kysely } from "kysely";

/**
 * Per-session generation statistics (doc/design/agent-runtime.md "Session statistics", doc/design/webui.md "Composer"):
 *
 * - `stat_turns`, `stat_steps`: user inputs that led to at least one model call, and main-agent model calls
 *   of this session (title generation, compaction and subagents do not count).
 * - `stat_ttft_ms`, `stat_ttft_steps`: total time to first streamed delta and the number of steps it was
 *   observed for; `stat_decode_ms`, `stat_decode_tokens`: time after the first delta and the output tokens
 *   decoded in it. Timing is measured at the provider stream (doc/design/agent-runtime.md "Session statistics"), so it stays 0 for
 *   steps recorded before this migration (and for old ones at backfill time), which cannot be recovered.
 * - `counted_submission_id`: the newest submission already counted as a turn.
 * - `prompt_tokens`, `cache_read_tokens`: input (input + cache read + cache write) and cache read tokens of
 *   every model call, accumulated up the session tree like `usage_tokens`.
 *
 * Additive: SQLite can add the NOT NULL columns with a default in place, so no table rebuild is needed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	for (const column of [
		"stat_turns",
		"stat_steps",
		"stat_ttft_ms",
		"stat_ttft_steps",
		"stat_decode_ms",
		"stat_decode_tokens",
		"prompt_tokens",
		"cache_read_tokens",
	] as const) {
		await db.schema
			.alterTable("sessions")
			.addColumn(column, "bigint", (col) => col.notNull().defaultTo(0))
			.execute();
	}
	await db.schema.alterTable("sessions").addColumn("counted_submission_id", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("counted_submission_id").execute();
	for (const column of [
		"cache_read_tokens",
		"prompt_tokens",
		"stat_decode_tokens",
		"stat_decode_ms",
		"stat_ttft_steps",
		"stat_ttft_ms",
		"stat_steps",
		"stat_turns",
	] as const) {
		await db.schema.alterTable("sessions").dropColumn(column).execute();
	}
}

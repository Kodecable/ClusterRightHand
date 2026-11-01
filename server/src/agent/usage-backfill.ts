import type { UsageState } from "@earendil-works/pi-durable";
import { sql } from "kysely";
import type { Db } from "../storage/db.ts";

/**
 * Backfills the statistics measure for sessions that predate it (D101, doc/agent-runtime.md#配额). The migration
 * can only add the column: the calls to sum live in durable's store, and the runtime reads them through the
 * Harness's snapshot API, so this runs at startup, before requests are accepted, and once per database.
 *
 * What durable recorded for a conversation is its model calls (generation, compaction and tool-nested models).
 * Auto Review's own requests never pass through the Harness, and a document that was dropped is gone; those
 * calls stay out, which is why the flag is written in the same transaction as the values.
 *
 * The estimate the budget and the usage measures share is applied by `estimateTokens` at call time, so a call
 * durable recorded without counters (a provider that reported none) contributed 0 here.
 */

const FLAG = "usage_backfilled_at";

function count(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** The tokens one conversation's persisted usage adds up to: input + cache read + cache write + output. */
export function usageTokensOf(state: UsageState | undefined): number {
	if (!state) return 0;
	let total = 0;
	for (const bucket of [state.models, state.tools]) {
		for (const usage of Object.values(bucket)) {
			total += count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite) + count(usage.output);
		}
	}
	return total;
}

/**
 * Per session, the measure accumulated up the tree: its own calls plus every descendant's. `own` maps a session
 * id to the tokens its own conversation recorded.
 */
export function subtreeUsage(
	rows: readonly { id: string; parentSessionId: string | null }[],
	own: ReadonlyMap<string, number>,
): Map<string, number> {
	const children = new Map<string, string[]>();
	for (const row of rows) {
		if (row.parentSessionId === null) continue;
		children.set(row.parentSessionId, [...(children.get(row.parentSessionId) ?? []), row.id]);
	}
	const totals = new Map<string, number>();
	const visit = (id: string): number => {
		const cached = totals.get(id);
		if (cached !== undefined) return cached;
		let sum = own.get(id) ?? 0;
		for (const child of children.get(id) ?? []) sum += visit(child);
		totals.set(id, sum);
		return sum;
	};
	for (const row of rows) visit(row.id);
	return totals;
}

/**
 * Backfills `usage_tokens` for every session from durable's per-conversation usage, then records the flag. A
 * session's counter is raised to the subtree total, never lowered, so a call charged since the migration is
 * kept. The updates and the flag commit together: a failure leaves the database untouched for the next start.
 */
export async function backfillUsageTokens(
	db: Db,
	usageOf: (conversationId: string) => Promise<UsageState | undefined>,
	now: Date = new Date(),
): Promise<number> {
	const done = await db.selectFrom("server_meta").select("value").where("key", "=", FLAG).executeTakeFirst();
	if (done) return 0;
	const rows = await db.selectFrom("sessions").select(["id", "parent_session_id", "conversation_id"]).execute();
	const own = new Map<string, number>();
	for (const row of rows) {
		const tokens = usageTokensOf(await usageOf(row.conversation_id));
		if (tokens > 0) own.set(row.id, tokens);
	}
	const totals = subtreeUsage(
		rows.map((row) => ({ id: row.id, parentSessionId: row.parent_session_id })),
		own,
	);
	let updated = 0;
	await db.transaction().execute(async (trx) => {
		for (const [sessionId, tokens] of totals) {
			if (tokens <= 0) continue;
			await trx
				.updateTable("sessions")
				.set({ usage_tokens: sql`case when usage_tokens < ${tokens} then ${tokens} else usage_tokens end` })
				.where("id", "=", sessionId)
				.execute();
			updated++;
		}
		await trx.insertInto("server_meta").values({ key: FLAG, value: now.toISOString() }).execute();
	});
	return updated;
}

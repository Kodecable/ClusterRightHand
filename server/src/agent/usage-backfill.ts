import type { UsageState } from "@earendil-works/pi-durable";
import { sql } from "kysely";
import type { Db } from "../storage/db.ts";

/**
 * Backfills the statistics measures for sessions that predate them (doc/design/agent-runtime.md "Quota and token accounting" and
 * "Session statistics"). The migration can only add the columns: the calls to sum live in durable's store, and the runtime
 * reads them through the Harness's snapshot API, so this runs at startup, before requests are accepted, and once
 * per database.
 *
 * What durable recorded for a conversation is its model calls (generation, compaction and tool-nested models).
 * Auto Review's own requests never pass through the Harness, and a document that was dropped is gone; those
 * calls stay out, which is why the flag is written in the same transaction as the values.
 *
 * The estimate the budget and the usage measures share is applied by `estimateTokens` at call time, so a call
 * durable recorded without counters (a provider that reported none) contributed 0 here.
 */

// A new key for the run that added the session statistics: a database whose usage backfill already ran under
// "usage_backfilled_at" must still get them. Every measure is raised, never lowered, so redoing the usage half
// there is harmless.
const FLAG = "session_stats_backfilled_at";

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

/** The input half of a conversation's persisted usage: input + cache read + cache write (doc/design/agent-runtime.md "Session statistics"). */
export function promptTokensOf(state: UsageState | undefined): number {
	if (!state) return 0;
	let total = 0;
	for (const bucket of [state.models, state.tools]) {
		for (const usage of Object.values(bucket)) {
			total += count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
		}
	}
	return total;
}

/** The cache-read tokens of a conversation's persisted usage (doc/design/agent-runtime.md "Session statistics"). */
export function cacheReadTokensOf(state: UsageState | undefined): number {
	if (!state) return 0;
	let total = 0;
	for (const bucket of [state.models, state.tools]) {
		for (const usage of Object.values(bucket)) total += count(usage.cacheRead);
	}
	return total;
}

/** A session's own steps and turns as durable's history can tell them. */
export interface HistoryCounts {
	/** Assistant entries that ended in the conversation. */
	steps: number;
	/** User entries followed by at least one assistant entry before the next user entry. */
	turns: number;
}

/**
 * Counts a conversation's assistant entries as steps and its user entries that led to one as turns
 * (doc/design/agent-runtime.md "Session statistics"). Entries must be in ascending order. Compaction summaries and resets are
 * their own entry kinds, so they are not mistaken for user input.
 */
export function historyCounts(entries: readonly { readonly kind: string }[]): HistoryCounts {
	let steps = 0;
	let turns = 0;
	let awaitingStep = false;
	for (const entry of entries) {
		if (entry.kind === "pi.user") awaitingStep = true;
		else if (entry.kind === "pi.assistant") {
			steps++;
			if (awaitingStep) {
				turns++;
				awaitingStep = false;
			}
		}
	}
	return { steps, turns };
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
 * Backfills the statistics measures for every session from durable's per-conversation usage and history, then
 * records the flag: `usage_tokens` (tree), `prompt_tokens` and `cache_read_tokens` (tree), and the session's own
 * `stat_steps`/`stat_turns`. A counter is raised, never lowered, so a call charged since the migration is kept.
 * Timing (TTFT/decode) cannot be recovered and stays 0. The updates and the flag commit together: a failure
 * leaves the database untouched for the next start.
 *
 * `historyOf` returns a conversation's entries in ascending order; without it only the token measures are
 * backfilled.
 */
export async function backfillUsageTokens(
	db: Db,
	usageOf: (conversationId: string) => Promise<UsageState | undefined>,
	now: Date = new Date(),
	historyOf?: (conversationId: string) => Promise<readonly { readonly kind: string }[]>,
): Promise<number> {
	const done = await db.selectFrom("server_meta").select("value").where("key", "=", FLAG).executeTakeFirst();
	if (done) return 0;
	const rows = await db.selectFrom("sessions").select(["id", "parent_session_id", "conversation_id"]).execute();
	const ownUsage = new Map<string, number>();
	const ownPrompt = new Map<string, number>();
	const ownCacheRead = new Map<string, number>();
	const ownSteps = new Map<string, number>();
	const ownTurns = new Map<string, number>();
	for (const row of rows) {
		const state = await usageOf(row.conversation_id);
		const usage = usageTokensOf(state);
		if (usage > 0) ownUsage.set(row.id, usage);
		const prompt = promptTokensOf(state);
		if (prompt > 0) ownPrompt.set(row.id, prompt);
		const cacheRead = cacheReadTokensOf(state);
		if (cacheRead > 0) ownCacheRead.set(row.id, cacheRead);
		if (!historyOf) continue;
		const history = historyCounts(await historyOf(row.conversation_id));
		if (history.steps > 0) ownSteps.set(row.id, history.steps);
		if (history.turns > 0) ownTurns.set(row.id, history.turns);
	}
	const parents = rows.map((row) => ({ id: row.id, parentSessionId: row.parent_session_id }));
	const usageTotals = subtreeUsage(parents, ownUsage);
	const promptTotals = subtreeUsage(parents, ownPrompt);
	const cacheReadTotals = subtreeUsage(parents, ownCacheRead);
	let updated = 0;
	await db.transaction().execute(async (trx) => {
		for (const row of rows) {
			const usage = usageTotals.get(row.id) ?? 0;
			const prompt = promptTotals.get(row.id) ?? 0;
			const cacheRead = cacheReadTotals.get(row.id) ?? 0;
			const steps = ownSteps.get(row.id) ?? 0;
			const turns = ownTurns.get(row.id) ?? 0;
			if (usage + prompt + cacheRead + steps + turns === 0) continue;
			await trx
				.updateTable("sessions")
				.set({
					...(usage > 0
						? { usage_tokens: sql`case when usage_tokens < ${usage} then ${usage} else usage_tokens end` }
						: {}),
					...(prompt > 0
						? { prompt_tokens: sql`case when prompt_tokens < ${prompt} then ${prompt} else prompt_tokens end` }
						: {}),
					...(cacheRead > 0
						? {
								cache_read_tokens: sql`case when cache_read_tokens < ${cacheRead} then ${cacheRead} else cache_read_tokens end`,
							}
						: {}),
					...(steps > 0 ? { stat_steps: sql`case when stat_steps < ${steps} then ${steps} else stat_steps end` } : {}),
					...(turns > 0 ? { stat_turns: sql`case when stat_turns < ${turns} then ${turns} else stat_turns end` } : {}),
				})
				.where("id", "=", row.id)
				.execute();
			updated++;
		}
		await trx.insertInto("server_meta").values({ key: FLAG, value: now.toISOString() }).execute();
	});
	return updated;
}

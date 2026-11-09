import type { SessionStats } from "@crh/api";
import type { Selectable } from "kysely";
import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import type { SessionsTable } from "../storage/schema.ts";
import { UserError } from "../util/errors.ts";
import type { StepTiming } from "./latency.ts";
import { sessionAncestors, sessionChain } from "./session-chain.ts";
import type { CallTokens } from "./tokens.ts";

/**
 * Token quotas (doc/agent-runtime.md#配额): every level of a session's chain may have a signed remaining-token
 * balance; null means unlimited and is never charged. The budget measure is charged to every level after a model
 * call (durable 1.4.0 cannot refuse a request), so a quota can go negative; a run continues only while every level
 * is above zero. The state of a session says when it is paused on an exhausted level. D101 keeps that budget
 * measure apart from the statistics usage measure by name.
 */

export function parseQuota(raw: unknown): number | null {
	if (raw === null) return null;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
		throw new UserError("quota must be an integer number of tokens (at least 0), or null for unlimited");
	}
	return raw;
}

export async function setQuota(db: Db, sessionId: string, quota: number | null): Promise<void> {
	await db.updateTable("sessions").set({ quota_tokens: quota }).where("id", "=", sessionId).execute();
}

/** A session's token counters (D101); a missing session reads as zero usage and no context. */
export interface SessionTokens {
	/** The budget measure: output tokens spent by the session and its subagents (doc/agent-runtime.md#配额). */
	budgetUsedTokens: number;
	/** The statistics measure: input + output tokens of the session and its subagents (D101). */
	usageTokens: number;
	/** The context fill of the session's own last main-agent call; null before the first one (D101). */
	contextTokens: number | null;
}

/** Reads the three token counters of one session row in one query. */
export async function sessionTokens(db: Db, sessionId: string): Promise<SessionTokens> {
	const row = await db
		.selectFrom("sessions")
		.select(["budget_used_tokens", "usage_tokens", "context_tokens"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	return {
		budgetUsedTokens: Number(row?.budget_used_tokens ?? 0),
		usageTokens: Number(row?.usage_tokens ?? 0),
		contextTokens:
			row?.context_tokens === null || row?.context_tokens === undefined ? null : Number(row.context_tokens),
	};
}

/** The budget measure: output tokens spent by the session and its subagents (doc/agent-runtime.md#配额). */
export async function budgetUsedTokens(db: Db, sessionId: string): Promise<number> {
	return (await sessionTokens(db, sessionId)).budgetUsedTokens;
}

/** The statistics measure: input + output tokens of the session and its subagents (D101). */
export async function usageTokens(db: Db, sessionId: string): Promise<number> {
	return (await sessionTokens(db, sessionId)).usageTokens;
}

/** The context fill of the session's own last main-agent call; null before the first one (D101). */
export async function contextTokens(db: Db, sessionId: string): Promise<number | null> {
	return (await sessionTokens(db, sessionId)).contextTokens;
}

/** A session's own generation statistics and its tree's token buckets (doc/agent-runtime.md#会话统计). */
export async function sessionStats(db: Db, sessionId: string): Promise<SessionStats> {
	const row = await db
		.selectFrom("sessions")
		.select([
			"stat_turns",
			"stat_steps",
			"stat_ttft_ms",
			"stat_ttft_steps",
			"stat_decode_ms",
			"stat_decode_tokens",
			"prompt_tokens",
			"cache_read_tokens",
		])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	return {
		turns: Number(row?.stat_turns ?? 0),
		steps: Number(row?.stat_steps ?? 0),
		ttftMs: Number(row?.stat_ttft_ms ?? 0),
		ttftSteps: Number(row?.stat_ttft_steps ?? 0),
		decodeMs: Number(row?.stat_decode_ms ?? 0),
		decodeTokens: Number(row?.stat_decode_tokens ?? 0),
		promptTokens: Number(row?.prompt_tokens ?? 0),
		cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
	};
}

/** Stores the input size of the session's own last main-agent call (D101). */
export async function setContextTokens(db: Db, sessionId: string, tokens: number): Promise<void> {
	await db
		.updateTable("sessions")
		.set({ context_tokens: Math.max(0, Math.round(tokens)) })
		.where("id", "=", sessionId)
		.execute();
}

/**
 * Charges one model call to every level of the chain, the root included: the budget (output only, reducing each
 * quota; quotas may go negative) and the statistics usage (input + output). Both display counters grow at every
 * level, for `GET /sessions/:id`. `prompt_tokens` and `cache_read_tokens` (doc/agent-runtime.md#会话统计) grow
 * with them: the input and cache read of the same calls, so a tree's cache hit is the same set of calls.
 *
 * `step` marks a main-agent call of this session: `stat_steps` grows, a new submission grows `stat_turns`, and
 * `timing` (the provider stream's start, first content and end, doc/agent-runtime.md#会话统计) grows the TTFT
 * and decode counters. These are the session's own counters, so the single statement's CASE keeps ancestors
 * unchanged; the counters and the usage measures therefore commit together.
 */
export async function chargeCall(
	db: Db,
	sessionId: string,
	tokens: CallTokens,
	step?: { timing?: StepTiming },
): Promise<void> {
	const budget = Math.max(0, Math.round(tokens.budget));
	const usage = Math.max(0, Math.round(tokens.usage));
	const prompt = Math.max(0, Math.round(tokens.context));
	const cacheRead = Math.max(0, Math.round(tokens.cacheRead ?? 0));
	const levels = await sessionChain(db, sessionId);
	await db
		.updateTable("sessions")
		.set({
			budget_used_tokens: sql`budget_used_tokens + ${budget}`,
			usage_tokens: sql`usage_tokens + ${usage}`,
			prompt_tokens: sql`prompt_tokens + ${prompt}`,
			cache_read_tokens: sql`cache_read_tokens + ${cacheRead}`,
			quota_tokens: sql`case when quota_tokens is null then null else quota_tokens - ${budget} end`,
			...(step
				? {
						stat_steps: sql`case when id = ${sessionId} then stat_steps + 1 else stat_steps end`,
						// One turn per submission that produced a step (doc/agent-runtime.md#会话统计): a retry or
						// another step of the same submission leaves `counted_submission_id` equal to it.
						stat_turns: sql`case when id = ${sessionId} and coalesce(counted_submission_id, '') <> coalesce(last_submission_id, '') then stat_turns + 1 else stat_turns end`,
						counted_submission_id: sql`case when id = ${sessionId} then last_submission_id else counted_submission_id end`,
					}
				: {}),
			...(step?.timing
				? {
						stat_ttft_ms: sql`case when id = ${sessionId} then stat_ttft_ms + ${Math.max(0, Math.round(step.timing.ttftMs))} else stat_ttft_ms end`,
						stat_ttft_steps: sql`case when id = ${sessionId} then stat_ttft_steps + 1 else stat_ttft_steps end`,
						stat_decode_ms: sql`case when id = ${sessionId} then stat_decode_ms + ${Math.max(0, Math.round(step.timing.decodeMs))} else stat_decode_ms end`,
						stat_decode_tokens: sql`case when id = ${sessionId} then stat_decode_tokens + ${Math.max(0, Math.round(step.timing.outputTokens))} else stat_decode_tokens end`,
					}
				: {}),
		})
		.where("id", "in", levels)
		.execute();
}

/** The highest level of the chain (root first) whose quota is not above zero, if any. */
export async function exhaustedLevel(db: Db, sessionId: string): Promise<string | undefined> {
	const chain: Selectable<SessionsTable>[] = [];
	for await (const row of sessionAncestors(db, sessionId)) chain.push(row);
	for (const row of chain.reverse()) {
		if (row.quota_tokens === null) continue;
		if (Number(row.quota_tokens) <= 0) return row.id;
	}
	return undefined;
}

/** A cycle guard for a session chain; legitimate chains are far shorter than this. */
const MAX_CHAIN_DEPTH = 100;

/**
 * `exhaustedLevel` for several sessions at once: one recursive query over all their chains, so a read that
 * needs the paused level of every child does not walk each chain separately. Returns the highest exhausted
 * level of each session that has one.
 */
export async function exhaustedLevels(db: Db, sessionIds: readonly string[]): Promise<Map<string, string>> {
	if (sessionIds.length === 0) return new Map();
	const rows = await sql<{ start_id: string; level_id: string }>`
		with recursive chain(start_id, id, parent_session_id, quota_tokens, depth) as (
			select id, id, parent_session_id, quota_tokens, 0
			from sessions
			where id in (${sql.join(sessionIds)})
			union all
			select chain.start_id, parent.id, parent.parent_session_id, parent.quota_tokens, chain.depth + 1
			from chain
			join sessions as parent on parent.id = chain.parent_session_id
			where chain.depth < ${MAX_CHAIN_DEPTH}
		)
		select start_id, id as level_id
		from chain
		where quota_tokens is not null and quota_tokens <= 0
		order by start_id, depth desc
	`.execute(db);
	const out = new Map<string, string>();
	for (const row of rows.rows) if (!out.has(row.start_id)) out.set(row.start_id, row.level_id);
	return out;
}

/** Adds tokens to an exhausted level; only the paused call's state change ends the wait. */
export async function grantQuota(db: Db, levelId: string, tokens: number): Promise<void> {
	if (!Number.isInteger(tokens) || tokens <= 0) throw new UserError("tokens must be a positive integer");
	await db
		.updateTable("sessions")
		.set({ quota_tokens: sql`case when quota_tokens is null then null else quota_tokens + ${tokens} end` })
		.where("id", "=", levelId)
		.execute();
}

/** A session paused on an exhausted quota level. */
export interface QuotaWaitView {
	/** The paused session. */
	sessionId: string;
	/** The exhausted level to top up. */
	levelId: string;
	sessionTitle: string | null;
	levelTitle: string | null;
	levelQuota: number | null;
	/** The session whose agent handles the wait (the level's parent); empty for a root level, which the owner handles. */
	handlerId: string;
	since: string;
}

async function waitView(
	db: Db,
	row: {
		id: string;
		waiting_level_id: string;
		waiting_handler_id: string | null;
		title: string | null;
		state_changed_at: string | null;
	},
): Promise<QuotaWaitView | undefined> {
	const level = await db
		.selectFrom("sessions")
		.select(["title", "quota_tokens", "parent_session_id"])
		.where("id", "=", row.waiting_level_id)
		.executeTakeFirst();
	if (!level) return undefined;
	const quota = level.quota_tokens === null ? null : Number(level.quota_tokens);
	// The wait is over as soon as the level is above zero (or unlimited); the state write may not have landed yet.
	if (quota === null || quota > 0) return undefined;
	return {
		sessionId: row.id,
		levelId: row.waiting_level_id,
		sessionTitle: row.title,
		levelTitle: level.title,
		levelQuota: quota,
		handlerId: row.waiting_handler_id ?? level.parent_session_id ?? "",
		since: row.state_changed_at ?? "",
	};
}

/** Sessions paused on a level whose direct parent is `handlerSessionId`; a root level has no such handler. */
export async function awaitingQuotaChildren(db: Db, handlerSessionId: string): Promise<QuotaWaitView[]> {
	const rows = await db
		.selectFrom("sessions")
		.select(["id", "waiting_level_id", "waiting_handler_id", "title", "state_changed_at"])
		.where("state", "=", "awaiting")
		.where("waiting_kind", "=", "quota")
		.where("waiting_level_id", "is not", null)
		.where("waiting_handler_id", "=", handlerSessionId)
		.execute();
	const out: QuotaWaitView[] = [];
	for (const row of rows) {
		if (!row.waiting_level_id) continue;
		const view = await waitView(db, { ...row, waiting_level_id: row.waiting_level_id });
		if (view) out.push(view);
	}
	return out;
}

/** Every paused session (waking their handlers after a restart). */
export async function awaitingQuotaSessions(db: Db): Promise<QuotaWaitView[]> {
	const rows = await db
		.selectFrom("sessions")
		.select(["id", "waiting_level_id", "waiting_handler_id", "title", "state_changed_at"])
		.where("state", "=", "awaiting")
		.where("waiting_kind", "=", "quota")
		.where("waiting_level_id", "is not", null)
		.execute();
	const out: QuotaWaitView[] = [];
	for (const row of rows) {
		if (!row.waiting_level_id) continue;
		const view = await waitView(db, { ...row, waiting_level_id: row.waiting_level_id });
		if (view) out.push(view);
	}
	return out;
}

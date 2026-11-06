import type { Selectable } from "kysely";
import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import type { SessionsTable } from "../storage/schema.ts";
import { UserError } from "../users/service.ts";
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

/** The budget measure: output tokens spent by the session and its subagents (doc/agent-runtime.md#配额). */
export async function budgetUsedTokens(db: Db, sessionId: string): Promise<number> {
	const row = await db
		.selectFrom("sessions")
		.select("budget_used_tokens")
		.where("id", "=", sessionId)
		.executeTakeFirst();
	return Number(row?.budget_used_tokens ?? 0);
}

/** The statistics measure: input + output tokens of the session and its subagents (D101). */
export async function usageTokens(db: Db, sessionId: string): Promise<number> {
	const row = await db.selectFrom("sessions").select("usage_tokens").where("id", "=", sessionId).executeTakeFirst();
	return Number(row?.usage_tokens ?? 0);
}

/** The context fill of the session's own last main-agent call; null before the first one (D101). */
export async function contextTokens(db: Db, sessionId: string): Promise<number | null> {
	const row = await db.selectFrom("sessions").select("context_tokens").where("id", "=", sessionId).executeTakeFirst();
	return row?.context_tokens === null || row?.context_tokens === undefined ? null : Number(row.context_tokens);
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
 * level, for `GET /sessions/:id`.
 */
export async function chargeCall(db: Db, sessionId: string, tokens: CallTokens): Promise<void> {
	const budget = Math.max(0, Math.round(tokens.budget));
	const usage = Math.max(0, Math.round(tokens.usage));
	const levels = await sessionChain(db, sessionId);
	await db
		.updateTable("sessions")
		.set({
			budget_used_tokens: sql`budget_used_tokens + ${budget}`,
			usage_tokens: sql`usage_tokens + ${usage}`,
			quota_tokens: sql`case when quota_tokens is null then null else quota_tokens - ${budget} end`,
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

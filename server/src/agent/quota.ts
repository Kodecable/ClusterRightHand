import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";

/**
 * Token quotas (doc/agent-runtime.md#配额): a subagent's signed remaining-token balance, null for unlimited.
 * Root sessions keep quota 0 and are never charged. Usage is charged to every subagent level after a response
 * (durable 1.4.0 cannot refuse a request), so a quota can go negative; a run continues only while every level
 * is above zero. The subagent's state says when it is paused on an exhausted level.
 */

export type SessionState = "active" | "awaiting" | "stopped";

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

/** The session and its ancestors, this session first, root last; `root` marks the session without a parent. */
async function lineage(db: Db, sessionId: string): Promise<{ id: string; root: boolean }[]> {
	const out: { id: string; root: boolean }[] = [];
	for (let id: string | null = sessionId; id; ) {
		const row: { parent_session_id: string | null } | undefined = await db
			.selectFrom("sessions")
			.select("parent_session_id")
			.where("id", "=", id)
			.executeTakeFirst();
		out.push({ id, root: row?.parent_session_id === null || row === undefined });
		id = row?.parent_session_id ?? null;
	}
	return out;
}

/** Tokens spent by the session and its subagents. */
export async function spentTokens(db: Db, sessionId: string): Promise<number> {
	const row = await db.selectFrom("sessions").select("used_tokens").where("id", "=", sessionId).executeTakeFirst();
	return Number(row?.used_tokens ?? 0);
}

/**
 * Charges one response's tokens to every subagent level of the chain (root sessions have no quota and are not
 * charged); quotas may go negative. `used_tokens` still grows everywhere, for display.
 */
export async function recordUsage(db: Db, sessionId: string, tokens: number): Promise<void> {
	const used = Math.max(0, Math.round(tokens));
	const levels = await lineage(db, sessionId);
	await db
		.updateTable("sessions")
		.set({ used_tokens: sql`used_tokens + ${used}` })
		.where(
			"id",
			"in",
			levels.map((l) => l.id),
		)
		.execute();
	const charged = levels.filter((l) => !l.root).map((l) => l.id);
	if (charged.length === 0) return;
	await db
		.updateTable("sessions")
		.set({ quota_tokens: sql`case when quota_tokens is null then null else quota_tokens - ${used} end` })
		.where("id", "in", charged)
		.execute();
}

/** The highest subagent level of the chain (root first) whose quota is not above zero, if any. */
export async function exhaustedLevel(db: Db, sessionId: string): Promise<string | undefined> {
	for (const level of (await lineage(db, sessionId)).reverse()) {
		if (level.root) continue;
		const row = await db.selectFrom("sessions").select("quota_tokens").where("id", "=", level.id).executeTakeFirst();
		if (!row || row.quota_tokens === null) continue;
		if (Number(row.quota_tokens) <= 0) return level.id;
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

/** A subagent paused on an exhausted quota level. */
export interface QuotaWaitView {
	/** The paused session. */
	sessionId: string;
	/** The exhausted level to top up. */
	levelId: string;
	sessionTitle: string;
	levelTitle: string;
	levelQuota: number | null;
	since: string;
}

async function waitView(
	db: Db,
	row: { id: string; waiting_level_id: string; title: string; state_changed_at: string | null },
): Promise<QuotaWaitView | undefined> {
	const level = await db
		.selectFrom("sessions")
		.select(["title", "quota_tokens", "parent_session_id"])
		.where("id", "=", row.waiting_level_id)
		.executeTakeFirst();
	if (!level) return undefined;
	return {
		sessionId: row.id,
		levelId: row.waiting_level_id,
		sessionTitle: row.title,
		levelTitle: level.title,
		levelQuota: level.quota_tokens === null ? null : Number(level.quota_tokens),
		since: row.state_changed_at ?? "",
	};
}

/** Subagents paused on a level whose direct parent is `handlerSessionId`. */
export async function awaitingQuotaChildren(db: Db, handlerSessionId: string): Promise<QuotaWaitView[]> {
	const rows = await db
		.selectFrom("sessions")
		.select(["id", "waiting_level_id", "title", "state_changed_at"])
		.where("state", "=", "awaiting")
		.where("waiting_level_id", "is not", null)
		.execute();
	const out: QuotaWaitView[] = [];
	for (const row of rows) {
		if (!row.waiting_level_id) continue;
		const view = await waitView(db, { ...row, waiting_level_id: row.waiting_level_id });
		if (!view) continue;
		const level = await db
			.selectFrom("sessions")
			.select("parent_session_id")
			.where("id", "=", row.waiting_level_id)
			.executeTakeFirst();
		if (level?.parent_session_id === handlerSessionId) out.push(view);
	}
	return out;
}

/** Every paused subagent (waking their parents after a restart). */
export async function awaitingQuotaSessions(db: Db): Promise<QuotaWaitView[]> {
	const rows = await db
		.selectFrom("sessions")
		.select(["id", "waiting_level_id", "title", "state_changed_at"])
		.where("state", "=", "awaiting")
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

export async function sessionStateOf(db: Db, sessionId: string): Promise<SessionState | undefined> {
	const row = await db.selectFrom("sessions").select("state").where("id", "=", sessionId).executeTakeFirst();
	return row?.state;
}

/**
 * Sets the subagent's state; unchanged states are not rewritten (keeps `since` meaningful). Returns the
 * state's timestamp, which identifies this wait: a new pause gets a new one, so the parent's wake is not
 * deduplicated against the previous pause.
 */
export async function setSessionState(
	db: Db,
	sessionId: string,
	state: SessionState,
	levelId: string | null,
): Promise<string> {
	const row = await db
		.selectFrom("sessions")
		.select(["state", "waiting_level_id", "state_changed_at"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return "";
	if (row.state === state && row.waiting_level_id === levelId) return row.state_changed_at ?? "";
	const at = new Date().toISOString();
	await db
		.updateTable("sessions")
		.set({ state, waiting_level_id: levelId, state_changed_at: at })
		.where("id", "=", sessionId)
		.execute();
	return at;
}

/** Marks subagent sessions stopped (cancelled, or a quota wait denied). */
export async function markSessionsStopped(db: Db, sessionIds: string[]): Promise<void> {
	if (sessionIds.length === 0) return;
	await db
		.updateTable("sessions")
		.set({ state: "stopped", waiting_level_id: null, state_changed_at: new Date().toISOString() })
		.where("id", "in", sessionIds)
		// Only subagents carry a state; a root session stays active when its subtree is aborted.
		.where("parent_session_id", "is not", null)
		.where("state", "!=", "stopped")
		.execute();
}

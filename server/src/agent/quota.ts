import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import type { QuotaRequestsTable } from "../storage/schema.ts";
import { UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";

/**
 * Token quotas (doc/agent-runtime.md#配额): one signed integer of remaining tokens per session, null for unlimited.
 * Usage is charged to the session and every level above it after each response (durable 1.4.0 cannot refuse a
 * request), so a quota can go negative when one response overspends; a run continues only while every level's
 * quota is above zero. No monetary cost is involved.
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

// ---- quota requests: a paused tool call asking an ancestor's agent, or the owner, for more quota ----

export type QuotaRequestState = "pending" | "granted" | "denied" | "cancelled";

export interface QuotaRequestView {
	id: string;
	/** The paused session whose tool call waits. */
	sessionId: string;
	/** The exhausted level to top up. */
	levelId: string;
	/** The session whose agent decides; null: the owner. */
	handlerSessionId: string | null;
	state: QuotaRequestState;
	grantedTokens: number | null;
	createdAt: string;
	sessionTitle: string;
	levelTitle: string;
	levelQuota: number | null;
}

async function viewOf(
	db: Db,
	row: {
		id: string;
		session_id: string;
		level_id: string;
		handler_session_id: string | null;
		state: string;
		granted_tokens: number | bigint | null;
		created_at: string;
	},
): Promise<QuotaRequestView> {
	const [session, level] = await Promise.all([
		db.selectFrom("sessions").select("title").where("id", "=", row.session_id).executeTakeFirst(),
		db.selectFrom("sessions").select(["title", "quota_tokens"]).where("id", "=", row.level_id).executeTakeFirst(),
	]);
	return {
		id: row.id,
		sessionId: row.session_id,
		levelId: row.level_id,
		handlerSessionId: row.handler_session_id,
		state: row.state as QuotaRequestState,
		grantedTokens: row.granted_tokens === null ? null : Number(row.granted_tokens),
		createdAt: row.created_at,
		sessionTitle: session?.title ?? "(deleted session)",
		levelTitle: level?.title ?? row.level_id,
		levelQuota: level?.quota_tokens === null || level?.quota_tokens === undefined ? null : Number(level.quota_tokens),
	};
}

type QuotaRequestRow = {
	id: string;
	session_id: string;
	level_id: string;
	handler_session_id: string | null;
	state: QuotaRequestsTable["state"];
	granted_tokens: number | bigint | null;
	created_at: string;
};

/** The pending request for this paused call, created on first ask (a rerun after a restart finds it). */
export async function ensureQuotaRequest(
	db: Db,
	input: { sessionId: string; levelId: string; handlerSessionId: string | null },
): Promise<QuotaRequestView> {
	const existing = await db
		.selectFrom("quota_requests")
		.selectAll()
		.where("session_id", "=", input.sessionId)
		.where("level_id", "=", input.levelId)
		.where("state", "=", "pending")
		.orderBy("created_at", "desc")
		.executeTakeFirst();
	let row: QuotaRequestRow = existing as QuotaRequestRow;
	if (!row) {
		const session = await db
			.selectFrom("sessions")
			.select("org_id")
			.where("id", "=", input.sessionId)
			.executeTakeFirst();
		if (!session) throw new Error("the session of a quota request is missing");
		row = {
			id: newId(),
			session_id: input.sessionId,
			level_id: input.levelId,
			handler_session_id: input.handlerSessionId,
			state: "pending",
			granted_tokens: null,
			created_at: new Date().toISOString(),
		};
		await db
			.insertInto("quota_requests")
			.values({ ...row, granted_tokens: null, org_id: session.org_id, resolved_at: null })
			.execute();
	}
	return viewOf(db, row);
}

export async function quotaRequestById(db: Db, id: string): Promise<QuotaRequestView | undefined> {
	const row = await db.selectFrom("quota_requests").selectAll().where("id", "=", id).executeTakeFirst();
	return row ? viewOf(db, row) : undefined;
}

/** Pending requests that this session's agent must settle. */
export async function pendingQuotaRequestsFor(db: Db, handlerSessionId: string): Promise<QuotaRequestView[]> {
	const rows = await db
		.selectFrom("quota_requests")
		.selectAll()
		.where("handler_session_id", "=", handlerSessionId)
		.where("state", "=", "pending")
		.orderBy("created_at")
		.execute();
	return Promise.all(rows.map((row) => viewOf(db, row)));
}

/** Adds tokens to the exhausted level; the request must still be pending. */
export async function grantQuota(db: Db, requestId: string, tokens: number): Promise<QuotaRequestView | undefined> {
	if (!Number.isInteger(tokens) || tokens <= 0) throw new UserError("tokens must be a positive integer");
	const row = await db.selectFrom("quota_requests").selectAll().where("id", "=", requestId).executeTakeFirst();
	if (!row || row.state !== "pending") return undefined;
	await db.transaction().execute(async (trx) => {
		await trx
			.updateTable("sessions")
			.set({ quota_tokens: sql`case when quota_tokens is null then null else quota_tokens + ${tokens} end` })
			.where("id", "=", row.level_id)
			.execute();
		await trx
			.updateTable("quota_requests")
			.set({ state: "granted", granted_tokens: tokens, resolved_at: new Date().toISOString() })
			.where("id", "=", requestId)
			.where("state", "=", "pending")
			.execute();
	});
	return quotaRequestById(db, requestId);
}

export async function denyQuota(db: Db, requestId: string): Promise<QuotaRequestView | undefined> {
	const res = await db
		.updateTable("quota_requests")
		.set({ state: "denied", resolved_at: new Date().toISOString() })
		.where("id", "=", requestId)
		.where("state", "=", "pending")
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) return undefined;
	return quotaRequestById(db, requestId);
}

/** Cancels the pending requests of stopped sessions, so their paused tools do not keep asking. */
export async function cancelQuotaRequests(db: Db, sessionIds: string[]): Promise<void> {
	if (sessionIds.length === 0) return;
	await db
		.updateTable("quota_requests")
		.set({ state: "cancelled", resolved_at: new Date().toISOString() })
		.where("session_id", "in", sessionIds)
		.where("state", "=", "pending")
		.execute();
}

/** The pause woke up because some quota is now available (a grant or the owner's own change). */
export async function settleQuotaRequests(db: Db, sessionId: string): Promise<void> {
	await db
		.updateTable("quota_requests")
		.set({ state: "granted", resolved_at: new Date().toISOString() })
		.where("session_id", "=", sessionId)
		.where("state", "=", "pending")
		.execute();
}

/** Every pending quota request (waking handlers after a restart). */
export async function pendingQuotaRequests(db: Db): Promise<QuotaRequestView[]> {
	const rows = await db
		.selectFrom("quota_requests")
		.selectAll()
		.where("state", "=", "pending")
		.orderBy("created_at")
		.execute();
	return Promise.all(rows.map((row) => viewOf(db, row)));
}

/** The newest request for this paused call, whatever its state. */
export async function latestQuotaRequest(
	db: Db,
	sessionId: string,
	levelId: string,
): Promise<QuotaRequestView | undefined> {
	const row = await db
		.selectFrom("quota_requests")
		.selectAll()
		.where("session_id", "=", sessionId)
		.where("level_id", "=", levelId)
		.orderBy("created_at", "desc")
		.executeTakeFirst();
	return row ? viewOf(db, row) : undefined;
}

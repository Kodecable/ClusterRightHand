import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";

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

/** The session and its ancestors, this session first, root last. */
async function lineage(db: Db, sessionId: string): Promise<string[]> {
	const ids: string[] = [];
	for (let id: string | null = sessionId; id; ) {
		ids.push(id);
		const row: { parent_session_id: string | null } | undefined = await db
			.selectFrom("sessions")
			.select("parent_session_id")
			.where("id", "=", id)
			.executeTakeFirst();
		id = row?.parent_session_id ?? null;
	}
	return ids;
}

/** Tokens spent by the session and its subagents. */
export async function spentTokens(db: Db, sessionId: string): Promise<number> {
	const row = await db.selectFrom("sessions").select("used_tokens").where("id", "=", sessionId).executeTakeFirst();
	return Number(row?.used_tokens ?? 0);
}

/** Charges one response's tokens to the session and every level above it; quotas may go negative. */
export async function recordUsage(db: Db, sessionId: string, tokens: number): Promise<void> {
	const used = Math.max(0, Math.round(tokens));
	const ids = await lineage(db, sessionId);
	await db
		.updateTable("sessions")
		.set({
			quota_tokens: sql`case when quota_tokens is null then null else quota_tokens - ${used} end`,
			used_tokens: sql`used_tokens + ${used}`,
		})
		.where("id", "in", ids)
		.execute();
}

/** The highest level of the chain (root first) whose quota is not above zero, if any. */
export async function exhaustedLevel(db: Db, sessionId: string): Promise<string | undefined> {
	for (const id of (await lineage(db, sessionId)).reverse()) {
		const row = await db.selectFrom("sessions").select("quota_tokens").where("id", "=", id).executeTakeFirst();
		if (!row || row.quota_tokens === null) continue;
		if (Number(row.quota_tokens) <= 0) return id;
	}
	return undefined;
}

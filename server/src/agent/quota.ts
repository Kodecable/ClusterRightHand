import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import { UserError } from "../users/service.ts";

/**
 * Token quotas (doc/agent-runtime.md#配额): every level of a session's chain may have a signed remaining-token
 * balance; null means unlimited and is never charged. Usage is charged to every level after a model call
 * (durable 1.4.0 cannot refuse a request), so a quota can go negative; a run continues only while every level is
 * above zero. The state of a session says when it is paused on an exhausted level.
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

/** The session and its ancestors, this session first, root last. */
export async function sessionChain(db: Db, sessionId: string): Promise<string[]> {
	const chain: string[] = [];
	for (let id: string | null = sessionId; id; ) {
		chain.push(id);
		const row: { parent_session_id: string | null } | undefined = await db
			.selectFrom("sessions")
			.select("parent_session_id")
			.where("id", "=", id)
			.executeTakeFirst();
		id = row?.parent_session_id ?? null;
	}
	return chain;
}

/** The parts of an assistant message the account reads; a pi-ai `AssistantMessage` satisfies it. */
export interface AccountedContent {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

export interface AccountedMessage {
	readonly usage?: { readonly output?: number } | null;
	readonly content?: readonly AccountedContent[];
}

const encoder = new TextEncoder();

/**
 * The tokens one model call is charged (D92, doc/agent-runtime.md#配额): the output the upstream reported
 * (reasoning included), or, when it reported none (`usage` missing, or `output` 0 for a message with content),
 * `ceil(bytes × 0.3)` over the message's text, visible thinking text and tool calls (name plus serialized
 * arguments). Input and cache tokens are never charged.
 */
export function accountedOutputTokens(message: AccountedMessage): number {
	const output = message.usage?.output;
	if (typeof output === "number" && Number.isFinite(output) && output > 0) return Math.round(output);
	const bytes = outputBytes(message.content ?? []);
	return bytes === 0 ? 0 : Math.ceil(bytes * 0.3);
}

function outputBytes(content: readonly AccountedContent[]): number {
	let bytes = 0;
	for (const block of content) {
		switch (block.type) {
			case "text":
				if (block.text) bytes += encoder.encode(block.text).length;
				break;
			case "thinking":
				if (block.thinking) bytes += encoder.encode(block.thinking).length;
				break;
			case "toolCall":
				bytes += encoder.encode(block.name ?? "").length;
				bytes += encoder.encode(JSON.stringify(block.arguments ?? null)).length;
				break;
		}
	}
	return bytes;
}

/** Tokens spent by the session and its subagents. */
export async function spentTokens(db: Db, sessionId: string): Promise<number> {
	const row = await db.selectFrom("sessions").select("used_tokens").where("id", "=", sessionId).executeTakeFirst();
	return Number(row?.used_tokens ?? 0);
}

/**
 * Charges one model call's tokens to every level of the chain that has a quota, the root included; quotas may go
 * negative. `used_tokens` grows at every level, for display.
 */
export async function recordUsage(db: Db, sessionId: string, tokens: number): Promise<void> {
	const used = Math.max(0, Math.round(tokens));
	const levels = await sessionChain(db, sessionId);
	await db
		.updateTable("sessions")
		.set({
			used_tokens: sql`used_tokens + ${used}`,
			quota_tokens: sql`case when quota_tokens is null then null else quota_tokens - ${used} end`,
		})
		.where("id", "in", levels)
		.execute();
}

/** The highest level of the chain (root first) whose quota is not above zero, if any. */
export async function exhaustedLevel(db: Db, sessionId: string): Promise<string | undefined> {
	for (const level of (await sessionChain(db, sessionId)).reverse()) {
		const row = await db.selectFrom("sessions").select("quota_tokens").where("id", "=", level).executeTakeFirst();
		if (!row || row.quota_tokens === null) continue;
		if (Number(row.quota_tokens) <= 0) return level;
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
	sessionTitle: string;
	levelTitle: string;
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
		title: string;
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
 * Sets the session's state; unchanged states are not rewritten (keeps `since` meaningful). Returns the state's
 * timestamp, which identifies this wait: a new pause gets a new one, so a handler's wake is not deduplicated
 * against the previous pause. A root's quota wait has no handler (the owner handles it).
 */
export async function setSessionState(
	db: Db,
	sessionId: string,
	state: SessionState,
	levelId: string | null,
): Promise<string> {
	const row = await db
		.selectFrom("sessions")
		.select(["state", "waiting_level_id", "waiting_handler_id", "state_changed_at"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return "";
	// A stopped session is revived only by a new input (which updates last_submission_id atomically), never by a state write.
	if (row.state === "stopped") return row.state_changed_at ?? "";
	// A quota wait is handled by the exhausted level's direct parent; store it so the handler can find it.
	let handlerId: string | null = null;
	if (state === "awaiting" && levelId) {
		handlerId =
			row.waiting_level_id === levelId && row.waiting_handler_id
				? row.waiting_handler_id
				: ((await parentOf(db, levelId)) ?? null);
	}
	if (row.state === state && row.waiting_level_id === levelId && row.waiting_handler_id === handlerId)
		return row.state_changed_at ?? "";
	const at = new Date().toISOString();
	let update = db
		.updateTable("sessions")
		.set({ state, waiting_level_id: levelId, waiting_handler_id: handlerId, state_changed_at: at, updated_at: at })
		.where("id", "=", sessionId);
	// A concurrent settle/abort may have written stopped after our read; never overwrite it here.
	if (state !== "stopped") update = update.where("state", "!=", "stopped");
	const res = await update.executeTakeFirst();
	return res.numUpdatedRows === 0n ? (row.state_changed_at ?? "") : at;
}

async function parentOf(db: Db, sessionId: string): Promise<string | null | undefined> {
	const row = await db
		.selectFrom("sessions")
		.select("parent_session_id")
		.where("id", "=", sessionId)
		.executeTakeFirst();
	return row?.parent_session_id;
}

/** Marks subagent sessions stopped (cancelled, or a quota wait denied). Roots stay active and are reset separately. */
export async function markSessionsStopped(db: Db, sessionIds: string[]): Promise<void> {
	if (sessionIds.length === 0) return;
	const at = new Date().toISOString();
	await db
		.updateTable("sessions")
		.set({
			state: "stopped",
			waiting_level_id: null,
			waiting_handler_id: null,
			state_changed_at: at,
			updated_at: at,
		})
		.where("id", "in", sessionIds)
		.where("parent_session_id", "is not", null)
		.where("state", "!=", "stopped")
		.execute();
}

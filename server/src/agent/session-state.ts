import type { Db } from "../storage/db.ts";
import type { SessionState, WaitingKind } from "../storage/schema.ts";

/**
 * The stored run state of a session (doc/agent-runtime.md#会话状态): roots and subagents share `idle` /
 * `running` / `awaiting`, and `waiting_kind` says what an awaiting session is blocked on. Only a new input
 * revives an idle session; every other state write either keeps it idle or corrects a live run.
 */

export type { SessionState, WaitingKind };

/** What an awaiting session waits for; `levelId` is the exhausted level of a quota wait. */
export interface SessionWait {
	kind: WaitingKind;
	levelId: string | null;
}

export async function sessionStateOf(db: Db, sessionId: string): Promise<SessionState | undefined> {
	const row = await db.selectFrom("sessions").select("state").where("id", "=", sessionId).executeTakeFirst();
	return row?.state;
}

/**
 * Sets the session's state and what it waits for; unchanged values are not rewritten (keeps `since`
 * meaningful). Returns the state's timestamp, which identifies this wait: a new pause gets a new one, so a
 * handler's wake is not deduplicated against the previous pause. Only a quota wait has a handler (the
 * exhausted level's direct parent); a root's quota wait has none, so its owner handles it.
 */
export async function setSessionState(
	db: Db,
	sessionId: string,
	state: SessionState,
	wait: SessionWait | null,
): Promise<string> {
	const row = await db
		.selectFrom("sessions")
		.select(["state", "waiting_kind", "waiting_level_id", "waiting_handler_id", "state_changed_at"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return "";
	const kind = state === "awaiting" ? (wait?.kind ?? null) : null;
	const levelId = state === "awaiting" && kind === "quota" ? (wait?.levelId ?? null) : null;
	let handlerId: string | null = null;
	if (kind === "quota" && levelId) {
		handlerId =
			row.waiting_kind === "quota" && row.waiting_level_id === levelId && row.waiting_handler_id
				? row.waiting_handler_id
				: ((await parentOf(db, levelId)) ?? null);
	}
	if (
		row.state === state &&
		row.waiting_kind === kind &&
		row.waiting_level_id === levelId &&
		row.waiting_handler_id === handlerId
	) {
		return row.state_changed_at ?? "";
	}
	const at = new Date().toISOString();
	await db
		.updateTable("sessions")
		.set({
			state,
			waiting_kind: kind,
			waiting_level_id: levelId,
			waiting_handler_id: handlerId,
			state_changed_at: at,
			updated_at: at,
		})
		.where("id", "=", sessionId)
		.execute();
	return at;
}

/** Ends the runs of these sessions (abort, or a denied quota wait): they become idle until a new input. */
export async function markSessionsIdle(db: Db, sessionIds: readonly string[]): Promise<void> {
	if (sessionIds.length === 0) return;
	const at = new Date().toISOString();
	await db
		.updateTable("sessions")
		.set({
			state: "idle",
			waiting_kind: null,
			waiting_level_id: null,
			waiting_handler_id: null,
			state_changed_at: at,
			updated_at: at,
		})
		.where("id", "in", [...sessionIds])
		.where("state", "!=", "idle")
		.execute();
}

async function parentOf(db: Db, sessionId: string): Promise<string | null | undefined> {
	const row = await db
		.selectFrom("sessions")
		.select("parent_session_id")
		.where("id", "=", sessionId)
		.executeTakeFirst();
	return row?.parent_session_id;
}

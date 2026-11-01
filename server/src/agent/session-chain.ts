import type { Selectable } from "kysely";
import type { Db } from "../storage/db.ts";
import type { SessionsTable } from "../storage/schema.ts";

/**
 * Walking a session's ancestors: a session's chain is its own row, then its parent's, up to the root
 * (doc/agent-runtime.md#会话状态). Subagents nest at most `MAX_SUBAGENT_DEPTH` levels, so a chain is short and
 * one indexed read per level is cheap; every caller shares this walk instead of repeating it.
 */

export type SessionRow = Selectable<SessionsTable>;

/**
 * The session and its ancestors as rows, this session first and the root last. A missing row (a session whose
 * parent was deleted) ends the walk, like a parent id of null. `undefined` starts nowhere, so a caller that
 * already has a parent id can walk from it.
 */
export async function* sessionAncestors(db: Db, sessionId: string | null | undefined): AsyncGenerator<SessionRow> {
	for (let id = sessionId ?? null; id; ) {
		const row = await db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
		if (!row) return;
		yield row;
		id = row.parent_session_id;
	}
}

/** The ids of the session and its ancestors, this session first, root last. */
export async function sessionChain(db: Db, sessionId: string): Promise<string[]> {
	const chain: string[] = [];
	for await (const row of sessionAncestors(db, sessionId)) chain.push(row.id);
	return chain;
}

/** The direct parent of a session; null for a root. */
export async function parentOf(db: Db, sessionId: string): Promise<string | null> {
	const row = await db
		.selectFrom("sessions")
		.select("parent_session_id")
		.where("id", "=", sessionId)
		.executeTakeFirst();
	return row?.parent_session_id ?? null;
}

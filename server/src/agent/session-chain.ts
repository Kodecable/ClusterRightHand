import { type Selectable, sql } from "kysely";
import type { Db } from "../storage/db.ts";
import type { SessionsTable } from "../storage/schema.ts";

/**
 * Walking the session tree: a session's chain is its own row, then its parent's, up to the root
 * (doc/agent-runtime.md#会话状态), and its subtree is every row below it. Subagents nest at most
 * `MAX_SUBAGENT_DEPTH` levels, so a chain is short and one indexed read per level is cheap; the downward walk is
 * one recursive query, guarded against a corrupt parent cycle. Every caller shares these walks.
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

/**
 * The tree's root id: `root_session_id` when it was backfilled, otherwise the last id of the parent walk (a
 * row inserted by hand or one predating the backfill). Undefined when the session does not exist.
 */
export async function rootSessionIdOf(db: Db, sessionId: string): Promise<string | undefined> {
	const row = await db
		.selectFrom("sessions")
		.select(["id", "root_session_id"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return undefined;
	if (row.root_session_id) return row.root_session_id;
	return (await sessionChain(db, sessionId)).at(-1);
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

/**
 * A cycle guard for the session tree. Legitimate subagents nest at most `MAX_SUBAGENT_DEPTH` levels, but old
 * data may be deeper, so the bound is well above the real limit: it only stops a corrupt parent cycle. Shared
 * by every downward or upward walk so one bad parent id cannot spin a query forever.
 */
export const MAX_SESSION_TREE_DEPTH = 100;

/** The ids of every session below this one, depth first. One recursive query, not one query per level. */
export async function sessionDescendants(db: Db, sessionId: string): Promise<string[]> {
	const result = await sql<{ id: string }>`
		with recursive session_tree(id, depth, path) as (
			select id, 1, id from sessions where parent_session_id = ${sessionId}
			union all
			select child.id, session_tree.depth + 1, session_tree.path || '/' || child.id
			from sessions as child
			join session_tree on child.parent_session_id = session_tree.id
			where session_tree.depth < ${MAX_SESSION_TREE_DEPTH}
		)
		select id from session_tree order by path
	`.execute(db);
	return result.rows.map((row) => row.id);
}

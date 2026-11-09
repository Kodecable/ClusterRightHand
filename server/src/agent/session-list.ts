import type { SessionListItem, SessionListScope } from "@crh/api";
import { type ExpressionBuilder, type RawBuilder, type SqlBool, sql } from "kysely";
import { isAdmin, type SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { Database } from "../storage/schema.ts";
import { userGroupIds } from "../users/shares.ts";
import { type CursorKey, descendingKeyset, encodeCursor } from "../util/cursor.ts";
import { UserError } from "../util/errors.ts";
import type { SessionState, WaitingKind } from "./session-state.ts";

export { SessionListHub, type SessionListHubOptions, type SessionListSubscriber } from "./session-list-hub.ts";

/**
 * The session list of the WebUI rewrite (doc/webui.md#会话列表): root sessions only, newest activity first,
 * with a keyset cursor, a scope, a title search and one owner name. The same item shape feeds the SSE stream,
 * always computed for the subscriber it is sent to, because `shared` depends on who asks.
 */

export type { SessionListItem, SessionListScope };

export interface SessionListFilter {
	scope: SessionListScope;
	/** Case-insensitive title substring; `%`, `_` and `\` are matched literally. */
	q?: string;
	scheduleId?: string;
	/**
	 * Only roots owned by this user. Served by the admin-only `all` scope; for every other scope it can only
	 * narrow what the caller may already see, so a foreign owner simply yields an empty page.
	 */
	ownerId?: string;
	cursor?: CursorKey;
}

/** The columns both lists turn into an item: the root list aggregates the tree into `state`, the children list reads it as is. */
export interface SessionItemRow {
	id: string;
	title: string | null;
	owner_user_id: string;
	schedule_id: string | null;
	state: SessionState;
	waiting_kind: WaitingKind | null;
	updated_at: string;
	display_name: string;
	username: string;
}

export interface SessionListRow extends SessionItemRow {
	parent_session_id: string | null;
	root_session_id: string | null;
	/** When the tree last left `running` for `idle`/`awaiting`; roots only (doc/webui.md#侧边列表). */
	reply_at: string | null;
	/** When the owner last opened the tree; roots only. */
	owner_read_at: string | null;
}

/** A row of `GET /api/sessions/:id/children`: the list's item columns, without the tree aggregate. */
export interface SessionChildRow extends SessionItemRow {
	parent_session_id: string | null;
}

/** A list row: the query also evaluates whether a share reaches the caller, so the item needs no extra query. */
export interface SessionListQueryRow extends SessionListRow {
	/** `EXISTS (...)` in SQL: 0/1 on SQLite, a boolean on PostgreSQL. */
	shared: SqlBool;
}

/**
 * Whether some session of the row's tree (`sessions`, the outer query's row) matches `condition`, a fixed SQL
 * fragment over the alias `tree`. See TREE_STATE for the second branch.
 */
function treeHas(condition: RawBuilder<unknown>): RawBuilder<SqlBool> {
	return sql<SqlBool>`exists (
		select 1 from sessions as tree
		where (tree.root_session_id = sessions.id or (tree.id = sessions.id and tree.root_session_id is null))
			and ${condition}
	)`;
}

/**
 * The tree's aggregate state, computed in SQL over `root_session_id` (doc/webui.md#SessionListItem): any
 * awaiting session makes the tree awaiting, else any running one makes it running. The second branch of each
 * condition also counts a root whose own `root_session_id` was never backfilled, so such a row cannot vanish
 * from its own aggregate. One index lookup per branch (`sessions_root_state_idx`), no per-row query.
 */
export const TREE_STATE = sql<SessionState>`case
	when ${treeHas(sql`tree.state = 'awaiting'`)} then 'awaiting'
	when ${treeHas(sql`tree.state = 'running'`)} then 'running'
	else 'idle'
end`;

/** The highest-priority wait among the tree's awaiting sessions: quota > approval > authorization. */
export const TREE_WAITING_KIND = sql<WaitingKind | null>`case
	when ${treeHas(sql`tree.state = 'awaiting' and tree.waiting_kind = 'quota'`)} then 'quota'
	when ${treeHas(sql`tree.state = 'awaiting' and tree.waiting_kind = 'approval'`)} then 'approval'
	when ${treeHas(sql`tree.state = 'awaiting' and tree.waiting_kind = 'authorization'`)} then 'authorization'
	else null
end`;

/** `%`, `_` and the escape character are matched literally inside a LIKE pattern. */
export function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The list query without its page size: the route adds `limit`, and the test explains the same query with
 * EXPLAIN QUERY PLAN. `all` is administrators only and is checked here again, not only in the route.
 */
export async function sessionListQuery(db: Db, user: SessionUser, filter: SessionListFilter) {
	// Group shares reach every member: fetch the caller's groups once, for both the `shared` scope and the
	// item's `shared` flag.
	const groupIds = await userGroupIds(db, user.userId);
	/** sharedSessionAccess's rule (directly or through a group) as one SQL predicate. */
	const shareReachesViewer = (eb: ExpressionBuilder<Database, "sessions" | "users">) =>
		eb.exists(
			eb
				.selectFrom("shares")
				.select("shares.id")
				.where("shares.resource_type", "=", "session")
				.whereRef("shares.resource_id", "=", "sessions.id")
				.where((share) =>
					share.or([
						share.and([share("shares.grantee_type", "=", "user"), share("shares.grantee_id", "=", user.userId)]),
						...(groupIds.length > 0
							? [
									share.and([
										share("shares.grantee_type", "=", "user_group"),
										share("shares.grantee_id", "in", groupIds),
									]),
								]
							: []),
					]),
				),
		);
	let query = db
		.selectFrom("sessions")
		.innerJoin("users", "users.id", "sessions.owner_user_id")
		.select([
			"sessions.id",
			"sessions.title",
			"sessions.owner_user_id",
			"sessions.parent_session_id",
			"sessions.root_session_id",
			"sessions.schedule_id",
			TREE_STATE.as("state"),
			TREE_WAITING_KIND.as("waiting_kind"),
			"sessions.updated_at",
			"sessions.reply_at",
			"sessions.owner_read_at",
			"users.display_name",
			"users.username",
		])
		.select((eb) => shareReachesViewer(eb).as("shared"))
		.where("sessions.parent_session_id", "is", null);
	if (filter.scheduleId !== undefined) query = query.where("sessions.schedule_id", "=", filter.scheduleId);
	if (filter.ownerId !== undefined && filter.ownerId !== "") {
		query = query.where("sessions.owner_user_id", "=", filter.ownerId);
	}
	switch (filter.scope) {
		case "mine":
			query = query.where("sessions.owner_user_id", "=", user.userId);
			break;
		case "shared": {
			// The same predicate in WHERE, plus the owner check: `shared` means "someone else's, shared to me".
			query = query.where("sessions.owner_user_id", "!=", user.userId).where(shareReachesViewer);
			break;
		}
		case "visible":
			// The WebUI's only scope: the caller's own roots plus the roots shared with them. No
			// administrator override, so an administrator's list is their own and shared sessions too.
			query = query.where((eb) => eb.or([eb("sessions.owner_user_id", "=", user.userId), shareReachesViewer(eb)]));
			break;
		case "all":
			if (!isAdmin(user)) throw new UserError("administrators only");
			break;
	}
	if (filter.q) {
		// lower() on both sides: SQLite's LIKE is case-insensitive for ASCII only, PostgreSQL's is
		// case-sensitive for everything; ESCAPE keeps % and _ literal. A NULL title (not generated yet)
		// cannot match; coalesce keeps the comparison a boolean instead of SQL NULL either way.
		const pattern = `%${escapeLike(filter.q)}%`;
		query = query.where(sql<SqlBool>`lower(coalesce(sessions.title, '')) like lower(${pattern}) escape '\\'`);
	}
	if (filter.cursor) {
		query = query.where(descendingKeyset(["sessions.updated_at"], filter.cursor, "sessions.id"));
	}
	return query.orderBy("sessions.updated_at", "desc").orderBy("sessions.id", "desc");
}

/**
 * A page of a session's direct child sessions (subagents), `updated_at desc, id desc`: the route adds `limit`
 * (doc/webui.md#api-约定). The item shows the child's own state, not the tree's, and its parent; the items are
 * never filtered per child, because a share on a session reaches its subagents (doc/access-control.md#归属与分享).
 * `sessions_parent_updated_idx` serves both the `parent_session_id` filter and the order, so a page costs one
 * index range scan and no per-row query.
 */
export function sessionChildrenQuery(db: Db, parentSessionId: string, cursor?: CursorKey) {
	let query = db
		.selectFrom("sessions")
		.innerJoin("users", "users.id", "sessions.owner_user_id")
		.select([
			"sessions.id",
			"sessions.title",
			"sessions.owner_user_id",
			"sessions.parent_session_id",
			"sessions.schedule_id",
			"sessions.state",
			"sessions.waiting_kind",
			"sessions.updated_at",
			"users.display_name",
			"users.username",
		])
		.where("sessions.parent_session_id", "=", parentSessionId);
	if (cursor) query = query.where(descendingKeyset(["sessions.updated_at"], cursor, "sessions.id"));
	return query.orderBy("sessions.updated_at", "desc").orderBy("sessions.id", "desc");
}

/**
 * The item as one viewer sees it. `shared` comes from the share reach the caller resolved: the list query's
 * `EXISTS` for the caller, or the audience the hub computed for a stream subscriber. An owner never has it set.
 * `unread` is the owner's alone: a shared viewer never sees another user's read state, so it is always false
 * there (doc/webui.md#侧边列表). A child row carries no read columns, which also leaves it false.
 */
export function sessionListItem(
	row: SessionItemRow & Partial<Pick<SessionListRow, "reply_at" | "owner_read_at">>,
	viewerUserId: string,
	shared: boolean,
): SessionListItem {
	const isOwner = row.owner_user_id === viewerUserId;
	const unread = isOwner && row.reply_at != null && (row.owner_read_at == null || row.reply_at > row.owner_read_at);
	return {
		id: row.id,
		title: row.title,
		ownerUserId: row.owner_user_id,
		ownerName: row.display_name || row.username,
		scheduleId: row.schedule_id,
		shared: shared && !isOwner,
		state: row.state,
		waitingKind: row.waiting_kind,
		unread,
		updatedAt: row.updated_at,
	};
}

/**
 * A child's item: the list's item plus the parent it hangs under. `shared` is the tree's, resolved from the
 * parent's permissions, so every child of one session carries the same answer.
 */
export function sessionChildItem(row: SessionChildRow, viewerUserId: string, shared: boolean): SessionListItem {
	return { ...sessionListItem(row, viewerUserId, shared), parentSessionId: row.parent_session_id };
}

export interface ShareAudience {
	granteeType: "user" | "user_group";
	granteeId: string;
}

/** The users a share reaches: the user itself, or the current members of the user group. */
export async function shareAudienceUserIds(db: Db, audience: ShareAudience): Promise<string[]> {
	if (audience.granteeType === "user") return [audience.granteeId];
	const rows = await db
		.selectFrom("user_group_members")
		.select("user_id")
		.where("user_group_id", "=", audience.granteeId)
		.execute();
	return rows.map((row) => row.user_id);
}

/** The keyset cursor of the session list: `updated_at desc, id desc`. */
export function sessionListCursor(updatedAt: string, id: string): string {
	return encodeCursor([updatedAt], id);
}

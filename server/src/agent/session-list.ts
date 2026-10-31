import { type ExpressionBuilder, type SqlBool, sql } from "kysely";
import { type CursorKey, descendingKeyset, encodeCursor } from "../api/cursor.ts";
import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { Database } from "../storage/schema.ts";
import { UserError } from "../users/service.ts";
import type { SessionState, WaitingKind } from "./session-state.ts";
import { userGroupIds } from "./sharing.ts";

/**
 * The session list of the WebUI rewrite (doc/webui.md#会话列表): root sessions only, newest activity first,
 * with a keyset cursor, a scope, a title search and one owner name. The same item shape feeds the SSE stream,
 * always computed for the subscriber it is sent to, because `shared` depends on who asks.
 */

/** The list's item; `GET /api/sessions/:id` still returns the full session. */
export interface SessionListItem {
	id: string;
	title: string;
	ownerUserId: string;
	ownerName: string;
	scheduleId: string | null;
	/** Owned by someone else and reached through a direct or group share (an administrator too, if shared). */
	shared: boolean;
	/** The whole session tree's state: any awaiting → awaiting, else any running → running, else idle. */
	state: SessionState;
	/** The highest-priority wait among the tree's awaiting sessions; null unless `state` is `awaiting`. */
	waitingKind: WaitingKind | null;
	updatedAt: string;
}

export type SessionListScope = "mine" | "shared" | "all";

export interface SessionListFilter {
	scope: SessionListScope;
	/** Case-insensitive title substring; `%`, `_` and `\` are matched literally. */
	q?: string;
	scheduleId?: string;
	cursor?: CursorKey;
}

export interface SessionListRow {
	id: string;
	title: string;
	owner_user_id: string;
	parent_session_id: string | null;
	root_session_id: string | null;
	schedule_id: string | null;
	state: SessionState;
	waiting_kind: WaitingKind | null;
	updated_at: string;
	display_name: string;
	username: string;
}

/** A list row: the query also evaluates whether a share reaches the caller, so the item needs no extra query. */
export interface SessionListQueryRow extends SessionListRow {
	/** `EXISTS (...)` in SQL: 0/1 on SQLite, a boolean on PostgreSQL. */
	shared: SqlBool;
}

/**
 * The tree's aggregate state, computed in SQL over `root_session_id` (doc/webui.md#SessionListItem): any
 * awaiting session makes the tree awaiting, else any running one makes it running. The second branch of each
 * condition also counts a root whose own `root_session_id` was never backfilled, so such a row cannot vanish
 * from its own aggregate. One index lookup per branch (`sessions_root_state_idx`), no per-row query.
 */
const TREE_STATE = sql<SessionState>`case
	when exists (
		select 1 from sessions as tree
		where (tree.root_session_id = sessions.id or (tree.id = sessions.id and tree.root_session_id is null))
			and tree.state = 'awaiting'
	) then 'awaiting'
	when exists (
		select 1 from sessions as tree
		where (tree.root_session_id = sessions.id or (tree.id = sessions.id and tree.root_session_id is null))
			and tree.state = 'running'
	) then 'running'
	else 'idle'
end`;

/** The highest-priority wait among the tree's awaiting sessions: quota > approval > authorization. */
const TREE_WAITING_KIND = sql<WaitingKind | null>`case
	when exists (
		select 1 from sessions as tree
		where (tree.root_session_id = sessions.id or (tree.id = sessions.id and tree.root_session_id is null))
			and tree.state = 'awaiting' and tree.waiting_kind = 'quota'
	) then 'quota'
	when exists (
		select 1 from sessions as tree
		where (tree.root_session_id = sessions.id or (tree.id = sessions.id and tree.root_session_id is null))
			and tree.state = 'awaiting' and tree.waiting_kind = 'approval'
	) then 'approval'
	when exists (
		select 1 from sessions as tree
		where (tree.root_session_id = sessions.id or (tree.id = sessions.id and tree.root_session_id is null))
			and tree.state = 'awaiting' and tree.waiting_kind = 'authorization'
	) then 'authorization'
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
			"users.display_name",
			"users.username",
		])
		.select((eb) => shareReachesViewer(eb).as("shared"))
		.where("sessions.parent_session_id", "is", null);
	if (filter.scheduleId !== undefined) query = query.where("sessions.schedule_id", "=", filter.scheduleId);
	switch (filter.scope) {
		case "mine":
			query = query.where("sessions.owner_user_id", "=", user.userId);
			break;
		case "shared": {
			// The same predicate in WHERE, plus the owner check: `shared` means "someone else's, shared to me".
			query = query.where("sessions.owner_user_id", "!=", user.userId).where(shareReachesViewer);
			break;
		}
		case "all":
			if (user.kind !== "admin") throw new UserError("administrators only");
			break;
	}
	if (filter.q) {
		// lower() on both sides: SQLite's LIKE is case-insensitive for ASCII only, PostgreSQL's is
		// case-sensitive for everything; ESCAPE keeps % and _ literal.
		const pattern = `%${escapeLike(filter.q)}%`;
		query = query.where(sql<SqlBool>`lower(sessions.title) like lower(${pattern}) escape '\\'`);
	}
	if (filter.cursor) {
		query = query.where(descendingKeyset(["sessions.updated_at"], filter.cursor, "sessions.id"));
	}
	return query.orderBy("sessions.updated_at", "desc").orderBy("sessions.id", "desc");
}

/**
 * The item as one viewer sees it. `shared` comes from the share reach the caller resolved: the list query's
 * `EXISTS` for the caller, or the audience the hub computed for a stream subscriber. An owner never has it set.
 */
export function sessionListItem(row: SessionListRow, viewerUserId: string, shared: boolean): SessionListItem {
	const isOwner = row.owner_user_id === viewerUserId;
	return {
		id: row.id,
		title: row.title,
		ownerUserId: row.owner_user_id,
		ownerName: row.display_name || row.username,
		scheduleId: row.schedule_id,
		shared: shared && !isOwner,
		state: row.state,
		waitingKind: row.waiting_kind,
		updatedAt: row.updated_at,
	};
}

export interface ShareAudience {
	granteeType: "user" | "user_group";
	granteeId: string;
}

/** The users a share reaches: the user itself, or the current members of the group. */
export async function shareAudienceUserIds(db: Db, audience: ShareAudience): Promise<string[]> {
	if (audience.granteeType === "user") return [audience.granteeId];
	const rows = await db
		.selectFrom("user_group_members")
		.select("user_id")
		.where("group_id", "=", audience.granteeId)
		.execute();
	return rows.map((row) => row.user_id);
}

/** One open `/api/sessions/stream` connection. The route owns the SSE write queue; the hub only decides what to send. */
export interface SessionListSubscriber {
	readonly user: SessionUser;
	send(event: "upsert" | "remove", data: SessionListItem | { id: string }): void;
	/** Ends the connection: a disabled user, or shutdown. */
	close(): void;
}

export interface SessionListHubOptions {
	db: Db;
	/** Coalesce window for writes to one session; a running session commits far more often than a list needs. */
	coalesceMs?: number;
}

/**
 * Publishes session-list changes to the open streams. Every event is computed for its subscriber: a session's
 * item differs by `shared`, and a session must never be mentioned to someone who can neither see it now nor
 * could see it immediately before the change (no id leaks on unshare, group removal or deletion).
 */
export class SessionListHub {
	readonly #db: Db;
	readonly #coalesceMs: number;
	readonly #subscribers = new Set<SessionListSubscriber>();
	/** Pending coalesced publishes, one timer per session. */
	readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();
	#closed = false;

	constructor(options: SessionListHubOptions) {
		this.#db = options.db;
		this.#coalesceMs = options.coalesceMs ?? 150;
	}

	get subscriberCount(): number {
		return this.#subscribers.size;
	}

	subscribe(subscriber: SessionListSubscriber): () => void {
		if (this.#closed) {
			subscriber.close();
			return () => {};
		}
		this.#subscribers.add(subscriber);
		return () => {
			this.#subscribers.delete(subscriber);
		};
	}

	/** A session row changed without changing who can see it; bursts are coalesced into one upsert. */
	publishSession(sessionId: string): void {
		// Nobody to tell: do not queue or query. A subscriber connecting later refetches its first page.
		if (this.#closed || this.#subscribers.size === 0 || this.#pending.has(sessionId)) return;
		const timer = setTimeout(() => {
			this.#pending.delete(sessionId);
			void this.#publishCurrent(sessionId).catch((err: unknown) => {
				console.error("session list: publishing a session change failed:", err);
			});
		}, this.#coalesceMs);
		timer.unref?.();
		this.#pending.set(sessionId, timer);
	}

	/** A share was added (or its access changed): its audience may see the session now. */
	async publishShareAdded(sessionId: string, audience: ShareAudience): Promise<void> {
		const pending = this.#takePending(sessionId);
		const row = await this.#row(sessionId);
		if (!row || row.parent_session_id !== null) return;
		const visible = await this.#visibleUserIds(sessionId);
		const targeted = new Set(await shareAudienceUserIds(this.#db, audience));
		// The new audience hears about the session; if a coalesced state change was taken over, publish it
		// now to everyone else. Visibility is recomputed here, so only the current audience gets an upsert.
		this.#sendUpsert(row, visible, targeted);
		if (pending) this.#sendUpsert(row, visible, undefined, targeted);
	}

	/**
	 * A share was removed. `userIds` is who it used to reach, captured before the row went away; they hear
	 * `remove` only if nothing else (ownership, another share) keeps the session visible.
	 */
	async publishShareRemoved(sessionId: string, userIds: readonly string[]): Promise<void> {
		const pending = this.#takePending(sessionId);
		const only = new Set(userIds);
		const row = await this.#row(sessionId);
		if (row && row.parent_session_id !== null) return; // never in the root-only list
		if (!row) {
			this.#sendRemove(sessionId, only);
			return;
		}
		const visible = await this.#visibleUserIds(sessionId);
		for (const subscriber of [...this.#subscribers]) {
			const userId = subscriber.user.userId;
			if (!only.has(userId)) continue;
			if (subscriber.user.kind === "admin" || visible.has(userId)) {
				this.#send(subscriber, "upsert", sessionListItem(row, userId, visible.has(userId)));
			} else {
				this.#send(subscriber, "remove", { id: sessionId });
			}
		}
		// A coalesced state change was taken over above; the rest of the audience still needs it. Computed
		// now, it leaves out whoever just lost access, so nobody gets an upsert after their `remove`.
		if (pending) this.#sendUpsert(row, visible, undefined, only);
	}

	/**
	 * The user joined or left a group: every root session shared with the group may have become visible or
	 * invisible to them.
	 */
	async publishGroupMemberChanged(groupId: string, userId: string, added: boolean): Promise<void> {
		const shares = await this.#db
			.selectFrom("shares")
			.select("resource_id")
			.where("resource_type", "=", "session")
			.where("grantee_type", "=", "user_group")
			.where("grantee_id", "=", groupId)
			.execute();
		for (const sessionId of new Set(shares.map((share) => share.resource_id))) {
			const row = await this.#row(sessionId);
			if (!row || row.parent_session_id !== null) continue;
			const visible = await this.#visibleUserIds(sessionId);
			for (const subscriber of [...this.#subscribers]) {
				if (subscriber.user.userId !== userId) continue;
				const canSee = subscriber.user.kind === "admin" || row.owner_user_id === userId || visible.has(userId);
				if (canSee) this.#send(subscriber, "upsert", sessionListItem(row, userId, visible.has(userId)));
				else if (!added) this.#send(subscriber, "remove", { id: sessionId });
			}
		}
	}

	/** The session is about to be deleted: everyone who can see it right now hears `remove`. */
	async publishSessionRemoved(sessionId: string): Promise<void> {
		// The remove below supersedes a queued upsert: the row is about to disappear, so there is nothing
		// left for the pending publish to send.
		this.#takePending(sessionId);
		const row = await this.#row(sessionId);
		if (!row || row.parent_session_id !== null) return;
		const visible = await this.#visibleUserIds(sessionId);
		for (const subscriber of [...this.#subscribers]) {
			if (
				subscriber.user.kind === "admin" ||
				row.owner_user_id === subscriber.user.userId ||
				visible.has(subscriber.user.userId)
			) {
				this.#send(subscriber, "remove", { id: sessionId });
			}
		}
	}

	/** A disabled (or deleted) user's streams end; their cookie is revoked too and the client goes to login. */
	endUserStreams(userId: string): void {
		for (const subscriber of [...this.#subscribers]) {
			if (subscriber.user.userId === userId) this.#end(subscriber);
		}
	}

	/** Shutdown: stop coalescing and end every stream, so the drain can go idle. */
	close(): void {
		this.#closed = true;
		for (const timer of this.#pending.values()) clearTimeout(timer);
		this.#pending.clear();
		for (const subscriber of [...this.#subscribers]) this.#end(subscriber);
	}

	async #publishCurrent(sessionId: string): Promise<void> {
		const row = await this.#row(sessionId);
		if (!row) return;
		// A subagent's state is part of its tree's item: every change publishes the root (doc/webui.md#会话列表).
		const root = row.parent_session_id === null ? row : await this.#row(await this.#rootOf(row));
		if (!root || root.parent_session_id !== null) return;
		this.#sendUpsert(root, await this.#visibleUserIds(root.id));
	}

	/** The root of a row that predates the root_session_id backfill (or a hand-built test row). */
	async #rootOf(row: SessionListRow): Promise<string> {
		if (row.root_session_id) return row.root_session_id;
		let id = row.parent_session_id;
		for (let depth = 0; id && depth <= 100; depth++) {
			const parent = await this.#db
				.selectFrom("sessions")
				.select(["id", "parent_session_id"])
				.where("id", "=", id)
				.executeTakeFirst();
			if (!parent) break;
			if (parent.parent_session_id === null) return parent.id;
			id = parent.parent_session_id;
		}
		return row.id;
	}

	/** The session row with its owner, whatever its parent; undefined when it is gone. */
	async #row(sessionId: string): Promise<SessionListRow | undefined> {
		return this.#db
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
				"users.display_name",
				"users.username",
			])
			.where("sessions.id", "=", sessionId)
			.executeTakeFirst();
	}

	/** Everyone a direct or group share reaches, other than the owner (who is checked separately). */
	async #visibleUserIds(sessionId: string): Promise<Set<string>> {
		const rows = await this.#db
			.selectFrom("shares")
			.select(["grantee_type", "grantee_id"])
			.where("resource_type", "=", "session")
			.where("resource_id", "=", sessionId)
			.execute();
		const out = new Set<string>();
		const groups: string[] = [];
		for (const row of rows) {
			if (row.grantee_type === "user") out.add(row.grantee_id);
			else groups.push(row.grantee_id);
		}
		if (groups.length > 0) {
			const members = await this.#db
				.selectFrom("user_group_members")
				.select("user_id")
				.where("group_id", "in", groups)
				.execute();
			for (const member of members) out.add(member.user_id);
		}
		return out;
	}

	/**
	 * Clears a session's coalescing timer and reports whether one was pending: a share/remove path that
	 * takes over a pending publish owes its audience the row, while a deletion's `remove` supersedes it.
	 */
	#takePending(sessionId: string): boolean {
		const timer = this.#pending.get(sessionId);
		if (!timer) return false;
		clearTimeout(timer);
		this.#pending.delete(sessionId);
		return true;
	}

	/**
	 * Sends an item computed for each subscriber: the same row has a different `shared` per viewer. `only`
	 * narrows the send to a share's audience, `skip` leaves out subscribers a targeted send already reached.
	 */
	#sendUpsert(
		row: SessionListRow,
		audience: ReadonlySet<string>,
		only?: ReadonlySet<string>,
		skip?: ReadonlySet<string>,
	): void {
		for (const subscriber of [...this.#subscribers]) {
			const userId = subscriber.user.userId;
			if (only && !only.has(userId)) continue;
			if (skip?.has(userId)) continue;
			const isOwner = row.owner_user_id === userId;
			if (!isOwner && subscriber.user.kind !== "admin" && !audience.has(userId)) continue;
			this.#send(subscriber, "upsert", sessionListItem(row, userId, audience.has(userId)));
		}
	}

	#sendRemove(sessionId: string, only: ReadonlySet<string>): void {
		for (const subscriber of [...this.#subscribers]) {
			if (only.has(subscriber.user.userId)) this.#send(subscriber, "remove", { id: sessionId });
		}
	}

	#send(subscriber: SessionListSubscriber, event: "upsert" | "remove", data: SessionListItem | { id: string }): void {
		try {
			subscriber.send(event, data);
		} catch (err) {
			console.error("session list: sending an event failed:", err);
			this.#end(subscriber);
		}
	}

	#end(subscriber: SessionListSubscriber): void {
		this.#subscribers.delete(subscriber);
		try {
			subscriber.close();
		} catch {}
	}
}

/** The keyset cursor of the session list: `updated_at desc, id desc`. */
export function sessionListCursor(updatedAt: string, id: string): string {
	return encodeCursor([updatedAt], id);
}

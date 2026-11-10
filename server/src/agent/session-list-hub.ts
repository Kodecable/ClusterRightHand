import { isAdmin, type SessionUser, webSessionAlive } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import {
	type SessionListItem,
	type SessionListRow,
	type SessionListScope,
	type ShareAudience,
	sessionListItem,
	shareAudienceUserIds,
	TREE_STATE,
	TREE_WAITING_KIND,
} from "./session-list.ts";

/** One open `/api/sessions/stream` connection. The route owns the SSE write queue; the hub only decides what to send. */
export interface SessionListSubscriber {
	readonly user: SessionUser;
	/**
	 * The stream's scope, with the list scopes' meanings. Omitted keeps the historical behaviour: everything
	 * the subscriber may see, which is every root session for an administrator. `visible` is the WebUI's
	 * owner-and-shared union, so an administrator's stream then leaves out the sessions only they can see.
	 */
	readonly scope?: SessionListScope;
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
	/** Views that outlive one request and must be re-checked when access changes (per-session event streams). */
	readonly #visibilityListeners = new Set<() => Promise<void> | void>();
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
			if (this.#receives(subscriber, row, visible)) {
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
	 * The user joined or left a user group: every root session shared with that user group may have become
	 * visible or invisible to them.
	 */
	async publishUserGroupMemberChanged(userGroupId: string, userId: string, added: boolean): Promise<void> {
		const shares = await this.#db
			.selectFrom("shares")
			.select("resource_id")
			.where("resource_type", "=", "session")
			.where("grantee_type", "=", "user_group")
			.where("grantee_id", "=", userGroupId)
			.execute();
		for (const sessionId of new Set(shares.map((share) => share.resource_id))) {
			const row = await this.#row(sessionId);
			if (!row || row.parent_session_id !== null) continue;
			const visible = await this.#visibleUserIds(sessionId);
			for (const subscriber of [...this.#subscribers]) {
				if (subscriber.user.userId !== userId) continue;
				if (this.#receives(subscriber, row, visible)) {
					this.#send(subscriber, "upsert", sessionListItem(row, userId, visible.has(userId)));
				} else if (!added) this.#send(subscriber, "remove", { id: sessionId });
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
			if (this.#receives(subscriber, row, visible)) this.#send(subscriber, "remove", { id: sessionId });
		}
	}

	/** A disabled (or deleted) user's streams end; their cookie is revoked too and the client goes to login. */
	endUserStreams(userId: string): void {
		for (const subscriber of [...this.#subscribers]) {
			if (subscriber.user.userId === userId) this.#end(subscriber);
		}
	}

	/**
	 * Ends the streams of a user whose WebUI session was revoked without disabling the user (logout, password
	 * change, an administrator's password reset). The row is gone or expired, so the subscriber's cookie would
	 * no longer authenticate a new request.
	 */
	async revalidateWebSessions(userId: string): Promise<void> {
		for (const subscriber of [...this.#subscribers]) {
			if (subscriber.user.userId !== userId) continue;
			if (await webSessionAlive(this.#db, subscriber.user.sessionId)) continue;
			this.#end(subscriber);
		}
	}

	/**
	 * Registers a view that has to re-check who may see which session (an open per-session event stream, for
	 * one). Returns the unsubscribe.
	 */
	onVisibilityChanged(listener: () => Promise<void> | void): () => void {
		this.#visibilityListeners.add(listener);
		return () => {
			this.#visibilityListeners.delete(listener);
		};
	}

	/**
	 * A user's kind or status, a group membership, a share or a delete may have taken access away: let the
	 * registered views end what its viewer may no longer see. Awaited, so a closed stream is gone when the
	 * request that changed access returns.
	 */
	async publishVisibilityChanged(): Promise<void> {
		for (const listener of [...this.#visibilityListeners]) await listener();
	}

	/** Shutdown: stop coalescing and end every stream, so the drain can go idle. */
	close(): void {
		this.#closed = true;
		for (const timer of this.#pending.values()) clearTimeout(timer);
		this.#pending.clear();
		this.#visibilityListeners.clear();
		for (const subscriber of [...this.#subscribers]) this.#end(subscriber);
	}

	async #publishCurrent(sessionId: string): Promise<void> {
		const row = await this.#row(sessionId);
		if (!row) return;
		// A subagent's state is part of its tree's item: every change publishes the root (doc/design/webui.md "Session list API").
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
				"sessions.reply_at",
				"sessions.owner_read_at",
				"users.display_name",
				"users.username",
			])
			.where("sessions.id", "=", sessionId)
			.executeTakeFirst();
	}

	/** Everyone a direct or user-group share reaches, other than the owner (who is checked separately). */
	async #visibleUserIds(sessionId: string): Promise<Set<string>> {
		const rows = await this.#db
			.selectFrom("shares")
			.select(["grantee_type", "grantee_id"])
			.where("resource_type", "=", "session")
			.where("resource_id", "=", sessionId)
			.execute();
		const out = new Set<string>();
		const userGroupIds: string[] = [];
		for (const row of rows) {
			if (row.grantee_type === "user") out.add(row.grantee_id);
			else userGroupIds.push(row.grantee_id);
		}
		if (userGroupIds.length > 0) {
			const members = await this.#db
				.selectFrom("user_group_members")
				.select("user_id")
				.where("user_group_id", "in", userGroupIds)
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
			if (!this.#receives(subscriber, row, audience)) continue;
			this.#send(subscriber, "upsert", sessionListItem(row, userId, audience.has(userId)));
		}
	}

	/**
	 * Whether a subscriber's stream carries this session: the scopes are the list's, and `visible` is its
	 * owner-and-shared union. An unscoped stream keeps the historical audience, which includes every
	 * administrator for every session.
	 */
	#receives(subscriber: SessionListSubscriber, row: { owner_user_id: string }, audience: ReadonlySet<string>): boolean {
		const userId = subscriber.user.userId;
		const owner = row.owner_user_id === userId;
		const shared = audience.has(userId);
		switch (subscriber.scope) {
			case "mine":
				return owner;
			case "shared":
				return shared;
			case "visible":
				return owner || shared;
			default:
				return owner || shared || isAdmin(subscriber.user);
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

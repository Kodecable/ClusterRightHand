/**
 * Who a request came from (doc/design/webui.md "Shared components"): the one server builder that turns an
 * actor (a task's, an external call's or an audit event's) into the displayable `RequestSource` model.
 *
 * A session or subagent resolves to its root session, an API token to its name and a user to their
 * username. Task and approval sources have those three kinds only; an actor that is not one of them (a
 * schedule, a system process) is shown as the user it acted for, as the approvals page always did.
 *
 * Audit events also record actors that are not people: a schedule, the system and Auto Review. They keep
 * their own labels in the same model and are rendered by the same component.
 */
import type { RequestSource } from "@crh/api";
import type { Db } from "./storage/db.ts";

/** The actor fields every task, external call and audit event stores. */
export interface SourceActor {
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string;
}

/** The key of one actor inside a batch; two rows with the same actor share one source. */
export function sourceActorKey(actorType: string, actorId: string, onBehalfOfUserId: string): string {
	return `${actorType}\u0000${actorId}\u0000${onBehalfOfUserId}`;
}

function isSessionActor(type: string): boolean {
	return type === "session" || type === "subagent";
}

interface SessionName {
	id: string;
	title: string | null;
	rootId: string | null;
}

/**
 * The sources of several actors in a few queries, in the input order. Lists resolve all their rows here so a
 * page does not read one session, token and user per row.
 */
export async function requestSourcesFor(db: Db, actors: readonly SourceActor[]): Promise<Map<string, RequestSource>> {
	const sessionActorIds = new Set<string>();
	const tokenIds = new Set<string>();
	const userIds = new Set<string>();
	for (const actor of actors) {
		if (isSessionActor(actor.actorType)) sessionActorIds.add(actor.actorId);
		else if (actor.actorType === "api_token") tokenIds.add(actor.actorId);
		else userIds.add(actor.actorType === "user" ? actor.actorId : actor.onBehalfOfUserId);
	}
	const sessionRows =
		sessionActorIds.size === 0
			? []
			: await db
					.selectFrom("sessions")
					.select(["id", "title", "root_session_id"])
					.where("id", "in", [...sessionActorIds])
					.execute();
	const first = new Map<string, SessionName>(
		sessionRows.map((row) => [row.id, { id: row.id, title: row.title, rootId: row.root_session_id }] as const),
	);
	// A subagent's request is shown against the root session the user knows. Resolve every root in one query,
	// reusing rows already read for columns that are themselves roots.
	const rootIds = new Set<string>();
	for (const actor of actors) {
		if (!isSessionActor(actor.actorType)) continue;
		const row = first.get(actor.actorId);
		const rootId = row?.rootId ?? actor.actorId;
		if (!first.has(rootId)) rootIds.add(rootId);
	}
	if (rootIds.size > 0) {
		const roots = await db
			.selectFrom("sessions")
			.select(["id", "title", "root_session_id"])
			.where("id", "in", [...rootIds])
			.execute();
		for (const row of roots) first.set(row.id, { id: row.id, title: row.title, rootId: row.root_session_id });
	}
	const tokenRows =
		tokenIds.size === 0
			? []
			: await db
					.selectFrom("api_tokens")
					.select(["id", "name"])
					.where("id", "in", [...tokenIds])
					.execute();
	const tokenNames = new Map(tokenRows.map((row) => [row.id, row.name] as const));
	const userRows =
		userIds.size === 0
			? []
			: await db
					.selectFrom("users")
					.select(["id", "username"])
					.where("id", "in", [...userIds])
					.execute();
	const userNames = new Map(userRows.map((row) => [row.id, row.username] as const));

	const sources = new Map<string, RequestSource>();
	for (const actor of actors) {
		let source: RequestSource | undefined;
		if (isSessionActor(actor.actorType)) {
			const row = first.get(actor.actorId);
			const root = row === undefined ? undefined : (first.get(row.rootId ?? row.id) ?? row);
			if (root !== undefined) source = { type: "session", sessionId: root.id, title: root.title ?? "" };
		}
		if (source === undefined && actor.actorType === "api_token") {
			source = { type: "api_token", tokenId: actor.actorId, name: tokenNames.get(actor.actorId) ?? actor.actorId };
		}
		if (source === undefined) {
			const userId = actor.actorType === "user" ? actor.actorId : actor.onBehalfOfUserId;
			source = { type: "user", userId, username: userNames.get(userId) ?? userId };
		}
		sources.set(sourceActorKey(actor.actorType, actor.actorId, actor.onBehalfOfUserId), source);
	}
	return sources;
}

/** One actor's source; the single-row convenience over {@link requestSourcesFor}. */
export async function requestSourceFor(
	db: Db,
	actorType: string,
	actorId: string,
	onBehalfOfUserId: string,
): Promise<RequestSource> {
	const sources = await requestSourcesFor(db, [{ actorType, actorId, onBehalfOfUserId }]);
	const source = sources.get(sourceActorKey(actorType, actorId, onBehalfOfUserId));
	if (source === undefined) throw new Error("the request source was not resolved");
	return source;
}

/** The source key of an audit event; audit actors have no on-behalf field in their key. */
export function auditSourceKey(actorType: string, actorId: string): string {
	return `${actorType}\u0000${actorId}`;
}

/**
 * The sources of several audit events in a few queries. Unlike a task's source, an audit source keeps the
 * actor's own kind: a schedule names the schedule, Auto Review names itself and any other system actor is
 * simply the system.
 */
export async function auditSourcesFor(
	db: Db,
	events: readonly { actorType: string; actorId: string }[],
): Promise<Map<string, RequestSource>> {
	const sessionIds = new Set<string>();
	const tokenIds = new Set<string>();
	const userIds = new Set<string>();
	const scheduleIds = new Set<string>();
	for (const event of events) {
		if (isSessionActor(event.actorType)) sessionIds.add(event.actorId);
		else if (event.actorType === "api_token") tokenIds.add(event.actorId);
		else if (event.actorType === "user") userIds.add(event.actorId);
		else if (event.actorType === "schedule") scheduleIds.add(event.actorId);
	}
	const sessionRows =
		sessionIds.size === 0
			? []
			: await db
					.selectFrom("sessions")
					.select(["id", "title", "root_session_id"])
					.where("id", "in", [...sessionIds])
					.execute();
	const sessions = new Map(sessionRows.map((row) => [row.id, row] as const));
	const rootIds = new Set<string>();
	for (const event of events) {
		if (!isSessionActor(event.actorType)) continue;
		const row = sessions.get(event.actorId);
		const rootId = row?.root_session_id ?? event.actorId;
		if (!sessions.has(rootId)) rootIds.add(rootId);
	}
	if (rootIds.size > 0) {
		const roots = await db
			.selectFrom("sessions")
			.select(["id", "title", "root_session_id"])
			.where("id", "in", [...rootIds])
			.execute();
		for (const row of roots) sessions.set(row.id, row);
	}
	const tokenRows =
		tokenIds.size === 0
			? []
			: await db
					.selectFrom("api_tokens")
					.select(["id", "name"])
					.where("id", "in", [...tokenIds])
					.execute();
	const tokenNames = new Map(tokenRows.map((row) => [row.id, row.name] as const));
	const userRows =
		userIds.size === 0
			? []
			: await db
					.selectFrom("users")
					.select(["id", "username"])
					.where("id", "in", [...userIds])
					.execute();
	const userNames = new Map(userRows.map((row) => [row.id, row.username] as const));
	const scheduleRows =
		scheduleIds.size === 0
			? []
			: await db
					.selectFrom("schedules")
					.select(["id", "name"])
					.where("id", "in", [...scheduleIds])
					.execute();
	const scheduleNames = new Map(scheduleRows.map((row) => [row.id, row.name] as const));

	const sources = new Map<string, RequestSource>();
	for (const event of events) {
		const key = auditSourceKey(event.actorType, event.actorId);
		if (sources.has(key)) continue;
		let source: RequestSource;
		if (isSessionActor(event.actorType)) {
			const row = sessions.get(event.actorId);
			const root = row === undefined ? undefined : (sessions.get(row.root_session_id ?? row.id) ?? row);
			source =
				root === undefined ? { type: "system" } : { type: "session", sessionId: root.id, title: root.title ?? "" };
		} else if (event.actorType === "api_token") {
			source = {
				type: "api_token",
				tokenId: event.actorId,
				name: tokenNames.get(event.actorId) ?? event.actorId,
			};
		} else if (event.actorType === "user") {
			source = {
				type: "user",
				userId: event.actorId,
				username: userNames.get(event.actorId) ?? event.actorId,
			};
		} else if (event.actorType === "schedule") {
			source = {
				type: "schedule",
				scheduleId: event.actorId,
				name: scheduleNames.get(event.actorId) ?? event.actorId,
			};
		} else if (event.actorType === "system" && event.actorId === "auto-review") {
			source = { type: "auto_review" };
		} else {
			source = { type: "system" };
		}
		sources.set(key, source);
	}
	return sources;
}

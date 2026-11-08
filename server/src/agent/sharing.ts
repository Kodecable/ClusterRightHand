import type { Selectable } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { SharesTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { stronger, userGroupIds } from "../users/shares.ts";
import { newId } from "../util/id.ts";
import { sessionAncestors } from "./session-chain.ts";

/**
 * Session sharing (doc/access-control.md#归属与分享). A session acts for its owner: a user it is shared with
 * drives it within the owner's nodes and the session's own rules, and approvals still go to the owner.
 */

export type SessionShareAccess = "view" | "chat";

/** Effective capabilities of one user on one session; computed per request, never stored. */
export interface SessionCapabilities {
	view: boolean;
	chat: boolean;
	/** Whether the caller may list and revoke shares: the owner and administrators. */
	manageShares: boolean;
	/** Whether the caller may create a share: only the session's owner. */
	createShares: boolean;
	configure: boolean;
}

export type SessionRelationship = "owner" | "admin" | "shared";

export interface SessionPermissions {
	relationship: SessionRelationship;
	capabilities: SessionCapabilities;
	/**
	 * A share reaches the caller on this session or one of its ancestors: what the WebUI's list items call
	 * `shared` (doc/webui.md#SessionListItem). False for the owner, and for an administrator who is not a grantee.
	 */
	shared: boolean;
}

/** The single capability rule: owner, administrator, and the strongest share level. */
export function capabilitiesFor(
	isOwner: boolean,
	isAdmin: boolean,
	share: SessionShareAccess | undefined,
): SessionCapabilities {
	return {
		view: isOwner || isAdmin || share !== undefined,
		chat: isOwner || share === "chat",
		// An administrator may see and revoke existing shares, but creating one would let them into a
		// session that is otherwise read-only for them, so only the owner may share.
		manageShares: isOwner || isAdmin,
		createShares: isOwner,
		configure: isOwner,
	};
}

export interface SessionShare {
	id: string;
	sessionId: string;
	granteeType: "user" | "user_group";
	granteeId: string;
	/** Username or user group name, for display. */
	granteeName: string | null;
	access: SessionShareAccess;
	createdByUserId: string;
	createdAt: string;
}

/** The share levels of a session, weakest first (a node share orders `view < operate` instead). */
const ACCESS_LEVELS: readonly SessionShareAccess[] = ["view", "chat"];

/** The shares that reach the user directly or through a group, as sessionId -> strongest access. */
export async function sharedSessionAccess(
	db: Db,
	userId: string,
	sessionId?: string,
): Promise<Map<string, SessionShareAccess>> {
	const groupIds = await userGroupIds(db, userId);
	let q = db
		.selectFrom("shares")
		.select(["resource_id", "access"])
		.where("resource_type", "=", "session")
		.where((eb) =>
			groupIds.length > 0
				? eb.or([
						eb.and([eb("grantee_type", "=", "user"), eb("grantee_id", "=", userId)]),
						eb.and([eb("grantee_type", "=", "user_group"), eb("grantee_id", "in", groupIds)]),
					])
				: eb.and([eb("grantee_type", "=", "user"), eb("grantee_id", "=", userId)]),
		);
	if (sessionId) q = q.where("resource_id", "=", sessionId);
	const out = new Map<string, SessionShareAccess>();
	for (const r of await q.execute()) {
		if (r.access === "view" || r.access === "chat") {
			out.set(r.resource_id, stronger(ACCESS_LEVELS, out.get(r.resource_id), r.access));
		}
	}
	return out;
}

/** Strongest share on the session or one of its ancestors; a subagent is reached through its root. */
async function shareAccessFor(
	db: Db,
	shares: Map<string, SessionShareAccess>,
	sessionId: string,
): Promise<SessionShareAccess | undefined> {
	let access: SessionShareAccess | undefined;
	for await (const row of sessionAncestors(db, sessionId)) {
		const found = shares.get(row.id);
		if (found) access = stronger(ACCESS_LEVELS, access, found);
		if (access === "chat") break;
	}
	return access;
}

/**
 * What the user may do with the session; undefined if they cannot see it. Shares on an ancestor reach it.
 * Administrators view everything and may list and revoke shares, but only the owner may create one, and
 * administrators chat only through an explicit chat share.
 */
export async function sessionCapabilities(
	db: Db,
	user: SessionUser,
	sessionId: string,
): Promise<SessionPermissions | undefined> {
	const row = await db
		.selectFrom("sessions")
		.select(["owner_user_id", "parent_session_id"])
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return undefined;
	const isOwner = row.owner_user_id === user.userId;
	const isAdmin = user.kind === "admin";
	const share = isOwner ? undefined : await shareAccessFor(db, await sharedSessionAccess(db, user.userId), sessionId);
	if (!isOwner && !isAdmin && !share) return undefined;
	return {
		relationship: isOwner ? "owner" : isAdmin ? "admin" : "shared",
		capabilities: capabilitiesFor(isOwner, isAdmin, share),
		shared: share !== undefined,
	};
}

export async function listSessionShares(db: Db, sessionId: string): Promise<SessionShare[]> {
	const rows = await db
		.selectFrom("shares")
		.selectAll()
		.where("resource_type", "=", "session")
		.where("resource_id", "=", sessionId)
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	if (rows.length === 0) return [];
	// Only the grantees of these shares are named, not every user and group in the organization.
	const userIds = [...new Set(rows.filter((r) => r.grantee_type === "user").map((r) => r.grantee_id))];
	const groupIds = [...new Set(rows.filter((r) => r.grantee_type !== "user").map((r) => r.grantee_id))];
	const users =
		userIds.length === 0
			? new Map<string, string>()
			: new Map(
					(await db.selectFrom("users").select(["id", "username"]).where("id", "in", userIds).execute()).map((u) => [
						u.id,
						u.username,
					]),
				);
	const groups =
		groupIds.length === 0
			? new Map<string, string>()
			: new Map(
					(await db.selectFrom("user_groups").select(["id", "name"]).where("id", "in", groupIds).execute()).map((g) => [
						g.id,
						g.name,
					]),
				);
	return rows.map((r) =>
		toSessionShare(r, (r.grantee_type === "user" ? users.get(r.grantee_id) : groups.get(r.grantee_id)) ?? null),
	);
}

function toSessionShare(row: Selectable<SharesTable>, granteeName: string | null): SessionShare {
	return {
		id: row.id,
		sessionId: row.resource_id,
		granteeType: row.grantee_type === "user_group" ? "user_group" : "user",
		granteeId: row.grantee_id,
		granteeName,
		access: row.access === "chat" ? "chat" : "view",
		createdByUserId: row.created_by_user_id,
		createdAt: String(row.created_at),
	};
}

/** Sharing with the owner is refused: they already have more than any share grants. */
export async function shareSession(
	db: Db,
	input: {
		sessionId: string;
		granteeType: "user" | "user_group";
		granteeId: string;
		access: SessionShareAccess;
		createdBy: string;
	},
): Promise<SessionShare> {
	if (input.granteeType !== "user" && input.granteeType !== "user_group") {
		throw new UserError("granteeType must be user or user_group");
	}
	if (input.access !== "view" && input.access !== "chat") throw new UserError("access must be view or chat");
	const granteeName = await db
		.selectFrom(input.granteeType === "user" ? "users" : "user_groups")
		.select(input.granteeType === "user" ? "username" : "name")
		.where("id", "=", input.granteeId)
		.executeTakeFirst();
	if (!granteeName) throw new NotFoundError(input.granteeType === "user" ? "no such user" : "no such user group");
	const name = String(Object.values(granteeName)[0]);
	return db.transaction().execute(async (trx) => {
		const session = await trx
			.selectFrom("sessions")
			.select(["org_id", "owner_user_id"])
			.where("id", "=", input.sessionId)
			.executeTakeFirst();
		if (!session) throw new NotFoundError("no such session");
		if (input.granteeType === "user" && input.granteeId === input.createdBy) {
			throw new UserError("a session cannot be shared with yourself");
		}
		if (input.granteeType === "user" && input.granteeId === session.owner_user_id) {
			throw new UserError("the owner already has full access");
		}

		// One statement for both cases: two concurrent shares of the same pair would otherwise both read no
		// row and the loser would fail on the unique constraint instead of returning the share.
		await trx
			.insertInto("shares")
			.values({
				id: newId(),
				org_id: session.org_id,
				resource_type: "session",
				resource_id: input.sessionId,
				grantee_type: input.granteeType,
				grantee_id: input.granteeId,
				access: input.access,
				created_by_user_id: input.createdBy,
				created_at: new Date().toISOString(),
			})
			.onConflict((oc) =>
				oc
					.columns(["resource_type", "resource_id", "grantee_type", "grantee_id"])
					.doUpdateSet({ access: input.access }),
			)
			.execute();
		const saved = await trx
			.selectFrom("shares")
			.selectAll()
			.where("resource_type", "=", "session")
			.where("resource_id", "=", input.sessionId)
			.where("grantee_type", "=", input.granteeType)
			.where("grantee_id", "=", input.granteeId)
			.executeTakeFirstOrThrow();
		return toSessionShare(saved, name);
	});
}

export async function unshareSession(db: Db, sessionId: string, shareId: string): Promise<void> {
	const result = await db
		.deleteFrom("shares")
		.where("id", "=", shareId)
		.where("resource_type", "=", "session")
		.where("resource_id", "=", sessionId)
		.executeTakeFirst();
	if (result.numDeletedRows === 0n) throw new NotFoundError("no such share");
}

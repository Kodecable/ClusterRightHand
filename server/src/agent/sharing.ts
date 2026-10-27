import type { Selectable } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { SharesTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";

/**
 * Session sharing (doc/access-control.md#归属与分享). A session acts for its owner: a user it is shared with
 * drives it within the owner's nodes and the session's own rules, and approvals still go to the owner.
 */

export type SessionShareAccess = "view" | "chat";
/** `admin` may look, but does not drive someone else's session. */
export type SessionAccess = "owner" | "admin" | "chat" | "view";

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

const RANK: Record<SessionShareAccess, number> = { view: 1, chat: 2 };

function stronger(a: SessionShareAccess | undefined, b: SessionShareAccess): SessionShareAccess {
	return a === undefined || RANK[b] > RANK[a] ? b : a;
}

async function userGroupIds(db: Db, userId: string): Promise<string[]> {
	const rows = await db.selectFrom("user_group_members").select("group_id").where("user_id", "=", userId).execute();
	return rows.map((r) => r.group_id);
}

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
		if (r.access === "view" || r.access === "chat") out.set(r.resource_id, stronger(out.get(r.resource_id), r.access));
	}
	return out;
}

/** What the user may do with the session: undefined if they cannot see it. */
export async function sessionAccess(db: Db, user: SessionUser, sessionId: string): Promise<SessionAccess | undefined> {
	const row = await db.selectFrom("sessions").select("owner_user_id").where("id", "=", sessionId).executeTakeFirst();
	if (!row) return undefined;
	if (row.owner_user_id === user.userId) return "owner";
	if (user.kind === "admin") return "admin";
	return (await sharedSessionAccess(db, user.userId, sessionId)).get(sessionId);
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
	const users = new Map(
		(await db.selectFrom("users").select(["id", "username"]).execute()).map((u) => [u.id, u.username]),
	);
	const groups = new Map(
		(await db.selectFrom("user_groups").select(["id", "name"]).execute()).map((g) => [g.id, g.name]),
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
		if (input.granteeType === "user" && input.granteeId === session.owner_user_id) {
			throw new UserError("the owner already has full access");
		}

		const existing = await trx
			.selectFrom("shares")
			.selectAll()
			.where("resource_type", "=", "session")
			.where("resource_id", "=", input.sessionId)
			.where("grantee_type", "=", input.granteeType)
			.where("grantee_id", "=", input.granteeId)
			.executeTakeFirst();
		if (existing) {
			await trx.updateTable("shares").set({ access: input.access }).where("id", "=", existing.id).execute();
			return toSessionShare({ ...existing, access: input.access }, name);
		}
		const row: Selectable<SharesTable> = {
			id: newId(),
			org_id: session.org_id,
			resource_type: "session",
			resource_id: input.sessionId,
			grantee_type: input.granteeType,
			grantee_id: input.granteeId,
			access: input.access,
			created_by_user_id: input.createdBy,
			created_at: new Date().toISOString(),
		};
		await trx.insertInto("shares").values(row).execute();
		return toSessionShare(row, name);
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

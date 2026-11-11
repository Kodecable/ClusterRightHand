import { randomBytes } from "node:crypto";
import type { Db } from "../storage/db.ts";
import { newId } from "../util/id.ts";
import { hashToken } from "./token-hash.ts";

export const SESSION_COOKIE = "crh_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** last_seen_at is written at most this often per session. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionUser {
	sessionId: string;
	userId: string;
	username: string;
	kind: "admin" | "member";
}

/**
 * Whether a user is an administrator: the one predicate the admin gate and every conditional
 * "administrators may also …" check use, so the two kinds are never compared by hand.
 */
export function isAdmin(user: Pick<SessionUser, "kind">): boolean {
	return user.kind === "admin";
}

export async function createWebSession(
	db: Db,
	userId: string,
	meta: { ip?: string | null; userAgent?: string | null } = {},
	now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString("base64url");
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
	await db
		.insertInto("web_sessions")
		.values({
			id: newId(),
			token_hash: hashToken(token),
			user_id: userId,
			created_at: now.toISOString(),
			expires_at: expiresAt.toISOString(),
			last_seen_at: now.toISOString(),
			ip: meta.ip ?? null,
			user_agent: meta.userAgent?.slice(0, 512) ?? null,
		})
		.execute();
	return { token, expiresAt };
}

/** Returns the session's user, or undefined if the token is unknown, expired, or the user is disabled. */
export async function resolveWebSession(db: Db, token: string, now = new Date()): Promise<SessionUser | undefined> {
	const row = await db
		.selectFrom("web_sessions as s")
		.innerJoin("users as u", "u.id", "s.user_id")
		.select(["s.id", "s.expires_at", "s.last_seen_at", "u.id as user_id", "u.username", "u.kind", "u.status"])
		.where("s.token_hash", "=", hashToken(token))
		.executeTakeFirst();
	if (row?.status !== "active" || Date.parse(row.expires_at) <= now.getTime()) return undefined;
	if (now.getTime() - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
		await db.updateTable("web_sessions").set({ last_seen_at: now.toISOString() }).where("id", "=", row.id).execute();
	}
	return { sessionId: row.id, userId: row.user_id, username: row.username, kind: row.kind };
}

/**
 * Whether a WebUI session is still usable (doc/guide/security.md "Authentication"): the row exists, has not expired,
 * and its user is still active. Open server-sent event streams keep their cookie for the life of the
 * connection, so they re-check this instead of trusting the authentication they started with; logout and a
 * password change delete the row, which is what ends the stream.
 */
export async function webSessionAlive(db: Db, webSessionId: string, now = new Date()): Promise<boolean> {
	const row = await db
		.selectFrom("web_sessions as s")
		.innerJoin("users as u", "u.id", "s.user_id")
		.select(["s.expires_at", "u.status"])
		.where("s.id", "=", webSessionId)
		.executeTakeFirst();
	return row !== undefined && row.status === "active" && Date.parse(row.expires_at) > now.getTime();
}

export async function revokeWebSession(db: Db, sessionId: string): Promise<void> {
	await db.deleteFrom("web_sessions").where("id", "=", sessionId).execute();
}

export async function revokeUserWebSessions(db: Db, userId: string, options: { except?: string } = {}): Promise<void> {
	let query = db.deleteFrom("web_sessions").where("user_id", "=", userId);
	if (options.except) query = query.where("id", "!=", options.except);
	await query.execute();
}

export async function deleteExpiredWebSessions(db: Db, now = new Date()): Promise<void> {
	await db.deleteFrom("web_sessions").where("expires_at", "<=", now.toISOString()).execute();
}

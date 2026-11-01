import { randomBytes } from "node:crypto";
import type { Preset } from "../policy/rules.ts";
import { createRootRuleSet, deleteRuleSet, getRuleSet, type StoredRuleSet } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId, NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import type { SessionUser } from "./sessions.ts";
import { hashToken } from "./token-hash.ts";

/** Recognizable by secret scanners; the rest is 32 random bytes. */
export const TOKEN_PREFIX = "crh_";
export const DEFAULT_TOKEN_DAYS = 90;
export const MAX_TOKEN_DAYS = 365;
const DAY = 86_400_000;
/** last_used_at is written at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;

export interface ApiTokenView {
	id: string;
	name: string;
	userId: string;
	createdAt: string;
	/** null: never expires. */
	expiresAt: string | null;
	revokedAt: string | null;
	lastUsedAt: string | null;
	rules: StoredRuleSet | null;
}

/**
 * Creates a token owned by `user`, the root of its own rule chain (doc/access-control.md#api-token).
 * `days`: lifetime, default 90, at most 365; null never expires. The token is returned only here.
 */
export async function createApiToken(
	db: Db,
	user: SessionUser,
	input: { name: string; preset: Preset; days?: number | null },
): Promise<{ token: string; view: ApiTokenView }> {
	const name = input.name.trim();
	if (!name || name.length > 100) throw new UserError("name must be 1 to 100 characters");
	const days = input.days === undefined ? DEFAULT_TOKEN_DAYS : input.days;
	if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS)) {
		throw new UserError(`days must be between 1 and ${MAX_TOKEN_DAYS}, or null for no expiry`);
	}
	const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
	const id = newId();
	const now = new Date();
	const orgId = await defaultOrgId(db);
	await db.transaction().execute(async (trx) => {
		await trx
			.insertInto("api_tokens")
			.values({
				id,
				org_id: orgId,
				user_id: user.userId,
				name,
				token_hash: hashToken(token),
				created_at: now.toISOString(),
				expires_at: days === null ? null : new Date(now.getTime() + days * DAY).toISOString(),
				revoked_at: null,
				last_used_at: null,
			})
			.execute();
		await createRootRuleSet(trx, orgId, { type: "api_token", id }, input.preset);
	});
	return { token, view: (await getApiToken(db, user, id)) as ApiTokenView };
}

async function toView(
	db: Db,
	row: {
		id: string;
		name: string;
		user_id: string;
		created_at: string;
		expires_at: string | null;
		revoked_at: string | null;
		last_used_at: string | null;
	},
): Promise<ApiTokenView> {
	return {
		id: row.id,
		name: row.name,
		userId: row.user_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
		lastUsedAt: row.last_used_at,
		rules: (await getRuleSet(db, { type: "api_token", id: row.id })) ?? null,
	};
}

/** A user's own tokens; tokens are never shared, so administrators see only theirs too. */
export async function listApiTokens(db: Db, user: SessionUser): Promise<ApiTokenView[]> {
	const rows = await db
		.selectFrom("api_tokens")
		.selectAll()
		.where("user_id", "=", user.userId)
		.orderBy("created_at", "desc")
		.execute();
	return Promise.all(rows.map((r) => toView(db, r)));
}

export async function getApiToken(db: Db, user: SessionUser, id: string): Promise<ApiTokenView | undefined> {
	const row = await db
		.selectFrom("api_tokens")
		.selectAll()
		.where("id", "=", id)
		.where("user_id", "=", user.userId)
		.executeTakeFirst();
	return row ? toView(db, row) : undefined;
}

/** Revokes a token; its rule set stays, so that past tasks keep their chain. */
export async function revokeApiToken(db: Db, user: SessionUser, id: string): Promise<void> {
	const res = await db
		.updateTable("api_tokens")
		.set({ revoked_at: new Date().toISOString() })
		.where("id", "=", id)
		.where("user_id", "=", user.userId)
		.where("revoked_at", "is", null)
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) throw new NotFoundError("no such active token");
}

/** Deletes a token for good; only revoked or expired tokens. */
export async function deleteApiToken(db: Db, user: SessionUser, id: string): Promise<void> {
	const row = await db
		.selectFrom("api_tokens")
		.selectAll()
		.where("id", "=", id)
		.where("user_id", "=", user.userId)
		.executeTakeFirst();
	if (!row) throw new NotFoundError("no such token");
	if (!row.revoked_at && !(row.expires_at && row.expires_at < new Date().toISOString())) {
		throw new UserError("revoke the token before deleting it");
	}
	await db.deleteFrom("api_tokens").where("id", "=", id).execute();
	await deleteRuleSet(db, { type: "api_token", id });
}

export interface TokenIdentity {
	user: SessionUser;
	tokenId: string;
}

/** Resolves a bearer token to its active user; undefined if unknown, revoked, expired or the user is disabled. */
export async function resolveApiToken(db: Db, token: string, now = new Date()): Promise<TokenIdentity | undefined> {
	if (!token.startsWith(TOKEN_PREFIX)) return undefined;
	const row = await db
		.selectFrom("api_tokens as t")
		.innerJoin("users as u", "u.id", "t.user_id")
		.select([
			"t.id",
			"t.expires_at",
			"t.revoked_at",
			"t.last_used_at",
			"u.id as user_id",
			"u.username",
			"u.kind",
			"u.status",
		])
		.where("t.token_hash", "=", hashToken(token))
		.executeTakeFirst();
	if (!row || row.revoked_at || row.status !== "active") return undefined;
	if (row.expires_at && row.expires_at <= now.toISOString()) return undefined;
	if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > TOUCH_INTERVAL_MS) {
		await db.updateTable("api_tokens").set({ last_used_at: now.toISOString() }).where("id", "=", row.id).execute();
	}
	return {
		tokenId: row.id,
		user: { userId: row.user_id, username: row.username, kind: row.kind, sessionId: `token:${row.id}` } as SessionUser,
	};
}

import type { User, UserKind, UserStatus } from "@crh/api";
import type { Selectable } from "kysely";
import { hashPassword } from "../auth/password.ts";
import type { Db } from "../storage/db.ts";
import { isPostgres } from "../storage/dialect.ts";
import type { UsersTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";

export type { UserKind, UserStatus };

/** The fields of a user that may leave the server; the API's `User`. */
export type PublicUser = User;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MIN_PASSWORD_LENGTH = 8;

export function toPublicUser(row: Omit<Selectable<UsersTable>, "password_hash">): PublicUser {
	return {
		id: row.id,
		username: row.username,
		displayName: row.display_name,
		email: row.email,
		kind: row.kind,
		status: row.status,
		createdAt: row.created_at,
	};
}

/**
 * The usernames of the given users, keyed by id: a page names only the users it shows, not the whole
 * organization. An empty list skips the query.
 */
export async function usernamesById(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
	if (ids.length === 0) return new Map();
	const rows = await db.selectFrom("users").select(["id", "username"]).where("id", "in", ids).execute();
	return new Map(rows.map((row) => [row.id, row.username]));
}

/** v1 has exactly one organization; it is created on first use. */
export async function defaultOrgId(db: Db): Promise<string> {
	const existing = await db.selectFrom("orgs").select("id").orderBy("created_at").executeTakeFirst();
	if (existing) return existing.id;
	const id = newId();
	await db.insertInto("orgs").values({ id, name: "default", created_at: new Date().toISOString() }).execute();
	return id;
}

export function validatePassword(password: string): void {
	if ([...password].length < MIN_PASSWORD_LENGTH) {
		throw new UserError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}
}

export async function createUser(
	db: Db,
	input: { username: string; displayName?: string; email?: string | null; kind: UserKind; password?: string },
): Promise<PublicUser> {
	const username = input.username.trim().toLowerCase();
	if (!USERNAME_RE.test(username)) {
		throw new UserError(
			"username must be 1-64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit",
		);
	}
	if (input.password !== undefined) validatePassword(input.password);
	const orgId = await defaultOrgId(db);
	const taken = await db
		.selectFrom("users")
		.select("id")
		.where("org_id", "=", orgId)
		.where("username", "=", username)
		.executeTakeFirst();
	if (taken) throw new UserError(`user ${username} already exists`);

	const row = {
		id: newId(),
		org_id: orgId,
		username,
		display_name: input.displayName?.trim() || username,
		email: input.email?.trim() || null,
		kind: input.kind,
		password_hash: input.password === undefined ? null : await hashPassword(input.password),
		status: "active" as const,
		created_at: new Date().toISOString(),
	};
	await db.insertInto("users").values(row).execute();
	return toPublicUser(row);
}

/**
 * Stores a new hash for the user without checking the password policy. The login rehash uses it: the
 * password was already verified, so a changed minimum length must not refuse a correct login.
 */
export async function storePasswordHash(db: Db, userId: string, password: string): Promise<void> {
	const result = await db
		.updateTable("users")
		.set({ password_hash: await hashPassword(password) })
		.where("id", "=", userId)
		.executeTakeFirst();
	if (result.numUpdatedRows === 0n) throw new NotFoundError("no such user");
}

export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
	validatePassword(password);
	await storePasswordHash(db, userId, password);
}

export async function findUserByUsername(db: Db, username: string) {
	const orgId = await defaultOrgId(db);
	return db
		.selectFrom("users")
		.selectAll()
		.where("org_id", "=", orgId)
		.where("username", "=", username.trim().toLowerCase())
		.executeTakeFirst();
}

export async function listUsers(db: Db): Promise<PublicUser[]> {
	const rows = await db.selectFrom("users").selectAll().orderBy("username").execute();
	return rows.map(toPublicUser);
}

/**
 * Applies a partial change. `by` is the administrator making it: another administrator must demote or disable
 * this one, so the request does not depend on the caller's own account staying usable.
 */
export async function updateUser(
	db: Db,
	userId: string,
	patch: { displayName?: string; email?: string | null; kind?: UserKind; status?: UserStatus },
	options: { by?: string } = {},
): Promise<PublicUser> {
	const set: Partial<Pick<UsersTable, "display_name" | "email" | "kind" | "status">> = {};
	if (patch.displayName !== undefined) {
		const displayName = patch.displayName.trim();
		if (!displayName) throw new UserError("displayName must not be empty");
		set.display_name = displayName;
	}
	if (patch.email !== undefined) set.email = patch.email?.trim() || null;
	if (patch.kind !== undefined) set.kind = patch.kind;
	if (patch.status !== undefined) set.status = patch.status;

	return db.transaction().execute(async (trx) => {
		// Serialize changes to administrators (PostgreSQL; SQLite transactions are already serialized), so two
		// concurrent demotions cannot both pass the "one active administrator" check below.
		if (isPostgres(trx)) {
			const orgId = await trx.selectFrom("users").select("org_id").where("id", "=", userId).executeTakeFirst();
			if (orgId) await trx.selectFrom("orgs").select("id").where("id", "=", orgId.org_id).forUpdate().execute();
		}
		const existing = await trx.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
		if (!existing) throw new NotFoundError("no such user");
		// No administrator may demote or disable themselves: another administrator must do it.
		const selfChange =
			options.by === userId &&
			((patch.kind !== undefined && patch.kind !== existing.kind) || patch.status === "disabled");
		if (selfChange) {
			throw new UserError("an administrator cannot demote or disable themselves; another administrator must do it");
		}
		if (Object.keys(set).length > 0) {
			await trx.updateTable("users").set(set).where("id", "=", userId).execute();
		}
		const row = await trx.selectFrom("users").selectAll().where("id", "=", userId).executeTakeFirst();
		if (!row) throw new NotFoundError("no such user");
		// Never leave the organization without an active administrator.
		const admins = await trx
			.selectFrom("users")
			.select((eb) => eb.fn.countAll<number | string | bigint>().as("n"))
			.where("org_id", "=", row.org_id)
			.where("kind", "=", "admin")
			.where("status", "=", "active")
			.executeTakeFirstOrThrow();
		if (Number(admins.n) === 0) throw new UserError("at least one active administrator is required");
		return toPublicUser(row);
	});
}

import type { LibraryLimits, UserGroup, UserGroupDetail } from "@crh/api";
import type { Db } from "../storage/db.ts";
import { defaultLibraryLimits, insertLibrary, withTransaction } from "../storage/library-rows.ts";
import { defaultOrgId } from "../storage/org.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import {
	likeContains,
	lowerCase,
	parseListQuery,
	prefixRank,
	type RawEntityListQuery,
	textMatches,
} from "../util/list-query.ts";

export type { UserGroup };

const USER_GROUP_NAME_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/** One searchable list page (see `queryUsers`). */
export interface UserGroupListPage {
	items: UserGroup[];
	more: boolean;
}

/**
 * `GET /api/user-groups` with the optional search parameters (doc/design/webui.md "Entity search").
 * Members are loaded only for the groups in the page; without parameters this is the old list.
 */
export async function queryUserGroups(db: Db, params: RawEntityListQuery): Promise<UserGroupListPage> {
	const query = parseListQuery(params);
	let select = db.selectFrom("user_groups").selectAll();
	if (query.ids !== undefined) select = select.where("id", "in", query.ids);
	if (query.q !== undefined) {
		select = select
			.where(textMatches(["name"], likeContains(query.q)))
			.orderBy(prefixRank(["name"], query.q))
			.orderBy(lowerCase("name"))
			.orderBy("id");
	} else {
		select = select.orderBy("name");
	}
	if (query.limit !== undefined) select = select.limit(query.limit + 1);
	const rows = await select.execute();
	const more = query.limit !== undefined && rows.length > query.limit;
	const groups = rows.slice(0, query.limit ?? rows.length);
	if (groups.length === 0) return { items: [], more };
	const members = await db
		.selectFrom("user_group_members")
		.select(["user_group_id", "user_id"])
		.where(
			"user_group_id",
			"in",
			groups.map((group) => group.id),
		)
		.execute();
	const memberIds = new Map<string, string[]>();
	for (const member of members) {
		const ids = memberIds.get(member.user_group_id) ?? [];
		ids.push(member.user_id);
		memberIds.set(member.user_group_id, ids);
	}
	return {
		items: groups.map((group) => ({
			id: group.id,
			name: group.name,
			source: group.source,
			createdAt: group.created_at,
			memberIds: memberIds.get(group.id) ?? [],
		})),
		more,
	};
}

export async function listUserGroups(db: Db): Promise<UserGroup[]> {
	return (await queryUserGroups(db, {})).items;
}

function normalizeUserGroupName(name: string): string {
	const normalized = name.trim().toLowerCase();
	if (!USER_GROUP_NAME_RE.test(normalized)) {
		throw new UserError("user group name must be 1-64 characters of a-z, 0-9, '.', '_' or '-', starting with a letter");
	}
	return normalized;
}

export interface CreateUserGroupOptions {
	/** The new library's limits; the defaults when omitted (doc/design/library.md "Limits"). */
	library?: LibraryLimits;
}

export async function createUserGroup(db: Db, name: string, options: CreateUserGroupOptions = {}): Promise<UserGroup> {
	const normalized = normalizeUserGroupName(name);
	const orgId = await defaultOrgId(db);
	const taken = await db
		.selectFrom("user_groups")
		.select("id")
		.where("org_id", "=", orgId)
		.where("name", "=", normalized)
		.executeTakeFirst();
	if (taken) throw new UserError(`user group ${normalized} already exists`);
	const row = {
		id: newId(),
		org_id: orgId,
		name: normalized,
		source: "local" as const,
		created_at: new Date().toISOString(),
	};
	await withTransaction(db, async (trx) => {
		await trx.insertInto("user_groups").values(row).execute();
		await insertLibrary(trx, "user_group", row.id, options.library ?? defaultLibraryLimits("user_group"));
	});
	return { id: row.id, name: row.name, source: row.source, createdAt: row.created_at, memberIds: [] };
}

/** `GET /api/user-groups/:id`: the group with its members; undefined when it does not exist. */
export async function getUserGroupDetail(db: Db, userGroupId: string): Promise<UserGroupDetail | undefined> {
	const group = await db
		.selectFrom("user_groups")
		.select(["id", "name", "created_at"])
		.where("id", "=", userGroupId)
		.executeTakeFirst();
	if (!group) return undefined;
	const members = await db
		.selectFrom("user_group_members")
		.innerJoin("users", "users.id", "user_group_members.user_id")
		.select(["users.id as id", "users.username as username", "users.display_name as display_name"])
		.where("user_group_members.user_group_id", "=", userGroupId)
		.orderBy("users.username")
		.execute();
	return {
		id: group.id,
		name: group.name,
		createdAt: group.created_at,
		members: members.map((member) => ({
			id: member.id,
			username: member.username,
			displayName: member.display_name,
		})),
	};
}

/** Renames a user group with the same normalized-name rules as creation. */
export async function renameUserGroup(db: Db, userGroupId: string, name: string): Promise<UserGroup | undefined> {
	const normalized = normalizeUserGroupName(name);
	const existing = await db
		.selectFrom("user_groups")
		.select(["id", "org_id"])
		.where("id", "=", userGroupId)
		.executeTakeFirst();
	if (!existing) throw new NotFoundError("no such user group");
	const taken = await db
		.selectFrom("user_groups")
		.select("id")
		.where("org_id", "=", existing.org_id)
		.where("name", "=", normalized)
		.where("id", "!=", userGroupId)
		.executeTakeFirst();
	if (taken) throw new UserError(`user group ${normalized} already exists`);
	await db.updateTable("user_groups").set({ name: normalized }).where("id", "=", userGroupId).execute();
	const row = await db.selectFrom("user_groups").selectAll().where("id", "=", userGroupId).executeTakeFirstOrThrow();
	const members = await db
		.selectFrom("user_group_members")
		.select("user_id")
		.where("user_group_id", "=", userGroupId)
		.execute();
	return {
		id: row.id,
		name: row.name,
		source: row.source,
		createdAt: row.created_at,
		memberIds: members.map((member) => member.user_id),
	};
}

/**
 * Deletes a user group and its shares. `beforeDelete` runs in the same transaction, so a caller above
 * users can remove rows that point at the group (node access grants) atomically.
 */
export async function deleteUserGroup(
	db: Db,
	userGroupId: string,
	beforeDelete?: (trx: Db) => Promise<void>,
): Promise<void> {
	await db.transaction().execute(async (trx) => {
		const group = await trx.selectFrom("user_groups").select(["name"]).where("id", "=", userGroupId).executeTakeFirst();
		if (!group) throw new NotFoundError("no such user group");
		// A group with files cannot be deleted: a mistaken deletion would lose them with no way back
		// (doc/design/library.md "Libraries"). The empty library row goes in the same transaction.
		const library = await trx
			.selectFrom("libraries")
			.select(["id", "used_files"])
			.where("owner_kind", "=", "user_group")
			.where("owner_id", "=", userGroupId)
			.executeTakeFirst();
		if (library && library.used_files > 0) {
			throw new UserError(
				`user group ${group.name} still has ${library.used_files} file(s) in its library; delete them before deleting the group`,
			);
		}
		if (library) {
			// Conditional, not a check-then-delete: an upload committing between the read above and
			// this delete would otherwise have its library row cascaded away (doc/design/library.md "Libraries").
			const removed = await trx
				.deleteFrom("libraries")
				.where("id", "=", library.id)
				.where("used_files", "=", 0)
				.executeTakeFirst();
			if (removed.numDeletedRows === 0n) {
				const current = await trx
					.selectFrom("libraries")
					.select("used_files")
					.where("id", "=", library.id)
					.executeTakeFirst();
				throw new UserError(
					`user group ${group.name} still has ${current?.used_files ?? library.used_files} file(s) in its library; delete them before deleting the group`,
				);
			}
		}
		await trx
			.deleteFrom("shares")
			.where("grantee_type", "=", "user_group")
			.where("grantee_id", "=", userGroupId)
			.execute();
		await beforeDelete?.(trx);
		await trx.deleteFrom("user_groups").where("id", "=", userGroupId).execute();
	});
}

export async function addUserGroupMember(db: Db, userGroupId: string, userId: string): Promise<void> {
	const [group, user, existing] = await Promise.all([
		db.selectFrom("user_groups").select("id").where("id", "=", userGroupId).executeTakeFirst(),
		db.selectFrom("users").select("id").where("id", "=", userId).executeTakeFirst(),
		db
			.selectFrom("user_group_members")
			.select("user_id")
			.where("user_group_id", "=", userGroupId)
			.where("user_id", "=", userId)
			.executeTakeFirst(),
	]);
	if (!group) throw new NotFoundError("no such user group");
	if (!user) throw new NotFoundError("no such user");
	if (existing) return;
	await db
		.insertInto("user_group_members")
		.values({ user_group_id: userGroupId, user_id: userId, created_at: new Date().toISOString() })
		.execute();
}

export async function removeUserGroupMember(db: Db, userGroupId: string, userId: string): Promise<void> {
	await db
		.deleteFrom("user_group_members")
		.where("user_group_id", "=", userGroupId)
		.where("user_id", "=", userId)
		.execute();
}

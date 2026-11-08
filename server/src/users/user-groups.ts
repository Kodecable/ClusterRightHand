import type { UserGroup } from "@crh/api";
import { deleteGrantsForUserGroup } from "../cluster/node-access.ts";
import type { Db } from "../storage/db.ts";
import { newId } from "../util/id.ts";
import { defaultOrgId, NotFoundError, UserError } from "./service.ts";

export type { UserGroup };

const USER_GROUP_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function listUserGroups(db: Db): Promise<UserGroup[]> {
	const groups = await db.selectFrom("user_groups").selectAll().orderBy("name").execute();
	const members = await db.selectFrom("user_group_members").select(["user_group_id", "user_id"]).execute();
	return groups.map((g) => ({
		id: g.id,
		name: g.name,
		source: g.source,
		createdAt: g.created_at,
		memberIds: members.filter((m) => m.user_group_id === g.id).map((m) => m.user_id),
	}));
}

export async function createUserGroup(db: Db, name: string): Promise<UserGroup> {
	const normalized = name.trim().toLowerCase();
	if (!USER_GROUP_NAME_RE.test(normalized)) {
		throw new UserError("user group name must be 1-64 characters of a-z, 0-9, '.', '_' or '-'");
	}
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
	await db.insertInto("user_groups").values(row).execute();
	return { id: row.id, name: row.name, source: row.source, createdAt: row.created_at, memberIds: [] };
}

export async function deleteUserGroup(db: Db, userGroupId: string): Promise<void> {
	await db.transaction().execute(async (trx) => {
		await trx
			.deleteFrom("shares")
			.where("grantee_type", "=", "user_group")
			.where("grantee_id", "=", userGroupId)
			.execute();
		await deleteGrantsForUserGroup(trx, userGroupId);
		const result = await trx.deleteFrom("user_groups").where("id", "=", userGroupId).executeTakeFirst();
		if (result.numDeletedRows === 0n) throw new NotFoundError("no such user group");
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

import type { AccessTargetType, GranteeType, NodeAccess, NodeAccessGrant } from "@crh/api";
import type { Selectable } from "kysely";
import { isAdmin, type SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { NodeAccessGrantsTable } from "../storage/schema.ts";
import { userGroupIds } from "../users/shares.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { newId } from "../util/id.ts";

/**
 * Node access (D108, doc/access-control.md#归属访问授权与分享): nodes belong to the organization. Only
 * administrators manage them; every other user reaches a node through a grant to the user or one of their user
 * groups, directly to the node or to a node group it is a member of. There is one level: see it and run tasks.
 */

export type { AccessTargetType, GranteeType, NodeAccess, NodeAccessGrant };

/** A grantee already has a grant on that target; the REST route maps it to 409. */
export class DuplicateGrantError extends UserError {}

/** The node and node-group ids a member reaches through direct and user-group grants. */
async function grantedTargets(db: Db, userId: string): Promise<{ nodeIds: Set<string>; nodeGroupIds: Set<string> }> {
	const groupIds = await userGroupIds(db, userId);
	const rows = await db
		.selectFrom("node_access_grants")
		.select(["target_type", "target_id"])
		.where((eb) =>
			groupIds.length > 0
				? eb.or([
						eb.and([eb("grantee_type", "=", "user"), eb("grantee_id", "=", userId)]),
						eb.and([eb("grantee_type", "=", "user_group"), eb("grantee_id", "in", groupIds)]),
					])
				: eb.and([eb("grantee_type", "=", "user"), eb("grantee_id", "=", userId)]),
		)
		.execute();
	const nodeIds = new Set<string>();
	const nodeGroupIds = new Set<string>();
	for (const row of rows) {
		if (row.target_type === "node") nodeIds.add(row.target_id);
		else nodeGroupIds.add(row.target_id);
	}
	return { nodeIds, nodeGroupIds };
}

/** Every node the user can see: all of them for an administrator, otherwise the granted set. */
export async function accessibleNodeIds(db: Db, user: SessionUser): Promise<string[]> {
	if (isAdmin(user)) {
		return (await db.selectFrom("nodes").select("id").execute()).map((row) => row.id);
	}
	const { nodeIds, nodeGroupIds } = await grantedTargets(db, user.userId);
	if (nodeGroupIds.size > 0) {
		const members = await db
			.selectFrom("node_group_members")
			.select("node_id")
			.where("node_group_id", "in", [...nodeGroupIds])
			.execute();
		for (const member of members) nodeIds.add(member.node_id);
	}
	return [...nodeIds];
}

/** How the user reaches the node; undefined when the node does not exist or is hidden from them. */
export async function nodeAccess(db: Db, user: SessionUser, nodeId: string): Promise<NodeAccess | undefined> {
	const node = await db.selectFrom("nodes").select("id").where("id", "=", nodeId).executeTakeFirst();
	if (!node) return undefined;
	if (isAdmin(user)) return "admin";
	const { nodeIds, nodeGroupIds } = await grantedTargets(db, user.userId);
	if (nodeIds.has(nodeId)) return "granted";
	if (nodeGroupIds.size === 0) return undefined;
	const member = await db
		.selectFrom("node_group_members")
		.select("node_id")
		.where("node_group_id", "in", [...nodeGroupIds])
		.where("node_id", "=", nodeId)
		.executeTakeFirst();
	return member ? "granted" : undefined;
}

/**
 * Whether a user id may reach a node. Used where only the actor's stored id is available (the on_behalf_of
 * user of a task before it is dispatched); the user may have been deleted, in which case they have no access.
 */
export async function userCanAccessNode(db: Db, userId: string, nodeId: string): Promise<boolean> {
	const user = await db.selectFrom("users").select(["id", "kind"]).where("id", "=", userId).executeTakeFirst();
	if (!user) return false;
	return (
		(await nodeAccess(db, { userId: user.id, username: "", kind: user.kind, sessionId: "" }, nodeId)) !== undefined
	);
}

function toGrant(row: Selectable<NodeAccessGrantsTable>, names: GrantNames): NodeAccessGrant {
	return {
		id: row.id,
		granteeType: row.grantee_type,
		granteeId: row.grantee_id,
		granteeName: names.grantee(row.grantee_type, row.grantee_id),
		targetType: row.target_type,
		targetId: row.target_id,
		targetName: names.target(row.target_type, row.target_id),
		createdAt: row.created_at,
		createdByUserId: row.created_by_user_id,
	};
}

interface GrantNames {
	grantee(type: GranteeType, id: string): string | null;
	target(type: AccessTargetType, id: string): string | null;
}

async function grantNames(db: Db): Promise<GrantNames> {
	const [users, groups, nodes, nodeGroups] = await Promise.all([
		db.selectFrom("users").select(["id", "username"]).execute(),
		db.selectFrom("user_groups").select(["id", "name"]).execute(),
		db.selectFrom("nodes").select(["id", "name"]).execute(),
		db.selectFrom("node_groups").select(["id", "name"]).execute(),
	]);
	const userNames = new Map(users.map((row) => [row.id, row.username]));
	const groupNames = new Map(groups.map((row) => [row.id, row.name]));
	const nodeNames = new Map(nodes.map((row) => [row.id, row.name]));
	const nodeGroupNames = new Map(nodeGroups.map((row) => [row.id, row.name]));
	return {
		grantee: (type, id) => (type === "user" ? (userNames.get(id) ?? null) : (groupNames.get(id) ?? null)),
		target: (type, id) => (type === "node" ? (nodeNames.get(id) ?? null) : (nodeGroupNames.get(id) ?? null)),
	};
}

export interface ListNodeAccessGrantsFilter {
	targetType?: AccessTargetType;
	targetId?: string;
	granteeType?: GranteeType;
	granteeId?: string;
}

export async function listNodeAccessGrants(
	db: Db,
	filter: ListNodeAccessGrantsFilter = {},
): Promise<NodeAccessGrant[]> {
	let query = db.selectFrom("node_access_grants").selectAll();
	if (filter.targetType) query = query.where("target_type", "=", filter.targetType);
	if (filter.targetId) query = query.where("target_id", "=", filter.targetId);
	if (filter.granteeType) query = query.where("grantee_type", "=", filter.granteeType);
	if (filter.granteeId) query = query.where("grantee_id", "=", filter.granteeId);
	const rows = await query.orderBy("created_at").orderBy("id").execute();
	const names = await grantNames(db);
	return rows.map((row) => toGrant(row, names));
}

export interface CreateNodeAccessGrantInput {
	orgId: string;
	granteeType: GranteeType;
	granteeId: string;
	targetType: AccessTargetType;
	targetId: string;
	createdByUserId: string;
}

/**
 * Creates one grant. A duplicate (the same grantee on the same target) is a UserError: the REST route turns it
 * into a 409, so a retried request does not silently look like a new grant.
 */
export async function createNodeAccessGrant(db: Db, input: CreateNodeAccessGrantInput): Promise<NodeAccessGrant> {
	if (input.granteeType !== "user" && input.granteeType !== "user_group") {
		throw new UserError("granteeType must be user or user_group");
	}
	if (input.targetType !== "node" && input.targetType !== "node_group") {
		throw new UserError("targetType must be node or node_group");
	}
	return db.transaction().execute(async (trx) => {
		const grantee = await trx
			.selectFrom(input.granteeType === "user" ? "users" : "user_groups")
			.select("id")
			.where("id", "=", input.granteeId)
			.where("org_id", "=", input.orgId)
			.executeTakeFirst();
		if (!grantee) throw new NotFoundError(input.granteeType === "user" ? "no such user" : "no such user group");
		const target = await trx
			.selectFrom(input.targetType === "node" ? "nodes" : "node_groups")
			.select("id")
			.where("id", "=", input.targetId)
			.where("org_id", "=", input.orgId)
			.executeTakeFirst();
		if (!target) throw new NotFoundError(input.targetType === "node" ? "no such node" : "no such node group");
		const existing = await trx
			.selectFrom("node_access_grants")
			.select("id")
			.where("grantee_type", "=", input.granteeType)
			.where("grantee_id", "=", input.granteeId)
			.where("target_type", "=", input.targetType)
			.where("target_id", "=", input.targetId)
			.executeTakeFirst();
		if (existing) throw new DuplicateGrantError("this grant already exists");
		const row: Selectable<NodeAccessGrantsTable> = {
			id: newId(),
			org_id: input.orgId,
			grantee_type: input.granteeType,
			grantee_id: input.granteeId,
			target_type: input.targetType,
			target_id: input.targetId,
			created_by_user_id: input.createdByUserId,
			created_at: new Date().toISOString(),
		};
		await trx.insertInto("node_access_grants").values(row).execute();
		return toGrant(row, await grantNames(trx));
	});
}

export async function getNodeAccessGrant(db: Db, id: string): Promise<NodeAccessGrant | undefined> {
	const row = await db.selectFrom("node_access_grants").selectAll().where("id", "=", id).executeTakeFirst();
	return row ? toGrant(row, await grantNames(db)) : undefined;
}

export async function deleteNodeAccessGrant(db: Db, id: string): Promise<void> {
	const result = await db.deleteFrom("node_access_grants").where("id", "=", id).executeTakeFirst();
	if (result.numDeletedRows === 0n) throw new NotFoundError("no such grant");
}

/** deletes the grants that point at a node; called when the node is deleted. */
export async function deleteGrantsForNode(db: Db, nodeId: string): Promise<void> {
	await db.deleteFrom("node_access_grants").where("target_type", "=", "node").where("target_id", "=", nodeId).execute();
}

/** Deletes the grants that point at a node group; called when the node group is deleted. */
export async function deleteGrantsForNodeGroup(db: Db, nodeGroupId: string): Promise<void> {
	await db
		.deleteFrom("node_access_grants")
		.where("target_type", "=", "node_group")
		.where("target_id", "=", nodeGroupId)
		.execute();
}

/** Deletes the grants granted to a user; called when the user is deleted. */
export async function deleteGrantsForUser(db: Db, userId: string): Promise<void> {
	await db
		.deleteFrom("node_access_grants")
		.where("grantee_type", "=", "user")
		.where("grantee_id", "=", userId)
		.execute();
}

/** Deletes the grants granted to a user group; called when the user group is deleted. */
export async function deleteGrantsForUserGroup(db: Db, userGroupId: string): Promise<void> {
	await db
		.deleteFrom("node_access_grants")
		.where("grantee_type", "=", "user_group")
		.where("grantee_id", "=", userGroupId)
		.execute();
}

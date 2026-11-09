import type { NodeGroup, NodeGroupRef } from "@crh/api";
import type { Db } from "../storage/db.ts";
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
import { assertNameAvailable, isUuid, nameKey, validateName } from "../util/names.ts";
import { deleteGrantsForNodeGroup } from "./node-access.ts";

/**
 * Node groups as crhs manages them (D108, D109): an organization-owned name and a membership list. A node group
 * and a node share one case-insensitive namespace, so every create and rename checks both tables inside its
 * transaction. References elsewhere store the group's UUID; names are only input and display.
 */

export type { NodeGroup, NodeGroupRef };

function toRef(row: { id: string; name: string }): NodeGroupRef {
	return { id: row.id, name: row.name };
}

/** The groups each node belongs to, ordered by name. */
export async function nodeGroupsForNodes(db: Db, nodeIds: string[]): Promise<Map<string, NodeGroupRef[]>> {
	const out = new Map<string, NodeGroupRef[]>();
	if (nodeIds.length === 0) return out;
	const rows = await db
		.selectFrom("node_group_members as m")
		.innerJoin("node_groups as g", "g.id", "m.node_group_id")
		.select(["m.node_id as node_id", "g.id as id", "g.name as name"])
		.where("m.node_id", "in", nodeIds)
		.orderBy("g.name")
		.orderBy("g.id")
		.execute();
	for (const row of rows) {
		const refs = out.get(row.node_id) ?? [];
		refs.push(toRef(row));
		out.set(row.node_id, refs);
	}
	return out;
}

/** The ids of the groups each node belongs to, for rule evaluation. */
export async function nodeGroupIdsForNodes(db: Db, nodeIds: string[]): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	if (nodeIds.length === 0) return out;
	const rows = await db
		.selectFrom("node_group_members")
		.select(["node_id", "node_group_id"])
		.where("node_id", "in", nodeIds)
		.execute();
	for (const row of rows) out.set(row.node_id, [...(out.get(row.node_id) ?? []), row.node_group_id]);
	return out;
}

/** One searchable list page (see `queryUsers`). */
export interface NodeGroupListPage {
	items: NodeGroup[];
	more: boolean;
}

/**
 * `GET /api/node-groups` with the optional search parameters (doc/webui.md "实体搜索").
 * Members are loaded only for the groups in the page; without parameters this is the old list.
 */
export async function queryNodeGroups(db: Db, params: RawEntityListQuery): Promise<NodeGroupListPage> {
	const query = parseListQuery(params);
	let select = db.selectFrom("node_groups").select(["id", "name"]);
	if (query.ids !== undefined) select = select.where("id", "in", query.ids);
	if (query.q !== undefined) {
		select = select
			.where(textMatches(["name"], likeContains(query.q)))
			.orderBy(prefixRank(["name"], query.q))
			.orderBy(lowerCase("name"))
			.orderBy("id");
	} else {
		select = select.orderBy("name").orderBy("id");
	}
	if (query.limit !== undefined) select = select.limit(query.limit + 1);
	const rows = await select.execute();
	const more = query.limit !== undefined && rows.length > query.limit;
	const groups = rows.slice(0, query.limit ?? rows.length);
	if (groups.length === 0) return { items: [], more };
	const members = await db
		.selectFrom("node_group_members")
		.select(["node_group_id", "node_id"])
		.where(
			"node_group_id",
			"in",
			groups.map((group) => group.id),
		)
		.execute();
	const memberIds = new Map<string, string[]>();
	for (const member of members) {
		const ids = memberIds.get(member.node_group_id) ?? [];
		ids.push(member.node_id);
		memberIds.set(member.node_group_id, ids);
	}
	return {
		items: groups.map((group) => ({
			...toRef(group),
			memberIds: memberIds.get(group.id) ?? [],
		})),
		more,
	};
}

export async function listNodeGroups(db: Db): Promise<NodeGroup[]> {
	return (await queryNodeGroups(db, {})).items;
}

export async function getNodeGroup(db: Db, id: string): Promise<NodeGroup | undefined> {
	const row = await db.selectFrom("node_groups").select(["id", "name"]).where("id", "=", id).executeTakeFirst();
	if (!row) return undefined;
	const members = await db.selectFrom("node_group_members").select("node_id").where("node_group_id", "=", id).execute();
	return { ...toRef(row), memberIds: members.map((m) => m.node_id) };
}

export async function createNodeGroup(db: Db, orgId: string, rawName: string): Promise<NodeGroup> {
	const name = validateName(rawName, "node group name");
	return db.transaction().execute(async (trx) => {
		await assertNameAvailable(trx, orgId, name);
		const now = new Date().toISOString();
		const row = {
			id: newId(),
			org_id: orgId,
			name,
			name_key: nameKey(name),
			created_at: now,
			updated_at: now,
		};
		await trx.insertInto("node_groups").values(row).execute();
		return { id: row.id, name: row.name, memberIds: [] };
	});
}

export async function renameNodeGroup(db: Db, groupId: string, rawName: string): Promise<NodeGroup> {
	const name = validateName(rawName, "node group name");
	return db.transaction().execute(async (trx) => {
		const group = await trx
			.selectFrom("node_groups")
			.select(["id", "org_id"])
			.where("id", "=", groupId)
			.executeTakeFirst();
		if (!group) throw new NotFoundError("no such node group");
		await assertNameAvailable(trx, group.org_id, name, { table: "node_groups", id: group.id });
		await trx
			.updateTable("node_groups")
			.set({ name, name_key: nameKey(name), updated_at: new Date().toISOString() })
			.where("id", "=", groupId)
			.execute();
		return (await getNodeGroup(trx, groupId)) as NodeGroup;
	});
}

export async function deleteNodeGroup(db: Db, groupId: string): Promise<void> {
	await db.transaction().execute(async (trx) => {
		// Explicit, like the other deletes: SQLite relies on `PRAGMA foreign_keys = ON`, which is set, but the
		// cascade is also the PostgreSQL behavior this matches.
		await deleteGrantsForNodeGroup(trx, groupId);
		await trx.deleteFrom("node_group_members").where("node_group_id", "=", groupId).execute();
		const result = await trx.deleteFrom("node_groups").where("id", "=", groupId).executeTakeFirst();
		if (result.numDeletedRows === 0n) throw new NotFoundError("no such node group");
	});
}

/** Replaces a group's members; every node id must name a node in the group's organization. */
export async function setNodeGroupMembers(
	db: Db,
	groupId: string,
	nodeIds: string[],
	now = new Date(),
): Promise<NodeGroup> {
	const unique = [...new Set(nodeIds)];
	return db.transaction().execute(async (trx) => {
		const group = await trx
			.selectFrom("node_groups")
			.select(["id", "org_id"])
			.where("id", "=", groupId)
			.executeTakeFirst();
		if (!group) throw new NotFoundError("no such node group");
		if (unique.length > 0) {
			const nodes = await trx
				.selectFrom("nodes")
				.select("id")
				.where("org_id", "=", group.org_id)
				.where("id", "in", unique)
				.execute();
			if (nodes.length !== unique.length) throw new UserError("no such node");
		}
		await trx.deleteFrom("node_group_members").where("node_group_id", "=", groupId).execute();
		if (unique.length > 0) {
			await trx
				.insertInto("node_group_members")
				.values(unique.map((nodeId) => ({ node_group_id: groupId, node_id: nodeId })))
				.execute();
		}
		await trx.updateTable("node_groups").set({ updated_at: now.toISOString() }).where("id", "=", groupId).execute();
		return (await getNodeGroup(trx, groupId)) as NodeGroup;
	});
}

/** Replaces which groups a node belongs to; a node may be in any number of groups. */
export async function setNodeGroupsForNode(
	db: Db,
	nodeId: string,
	groupIds: string[],
	now = new Date(),
): Promise<NodeGroupRef[]> {
	const unique = [...new Set(groupIds)];
	return db.transaction().execute(async (trx) => {
		const node = await trx.selectFrom("nodes").select(["id", "org_id"]).where("id", "=", nodeId).executeTakeFirst();
		if (!node) throw new NotFoundError("no such node");
		if (unique.length > 0) {
			const groups = await trx
				.selectFrom("node_groups")
				.select("id")
				.where("org_id", "=", node.org_id)
				.where("id", "in", unique)
				.execute();
			if (groups.length !== unique.length) throw new UserError("no such node group");
		}
		await trx.deleteFrom("node_group_members").where("node_id", "=", nodeId).execute();
		if (unique.length > 0) {
			await trx
				.insertInto("node_group_members")
				.values(unique.map((groupId) => ({ node_group_id: groupId, node_id: nodeId })))
				.execute();
		}
		if (unique.length > 0) {
			await trx.updateTable("node_groups").set({ updated_at: now.toISOString() }).where("id", "in", unique).execute();
		}
		return (await nodeGroupsForNodes(trx, [nodeId])).get(nodeId) ?? [];
	});
}

/** Resolves node-group names (case-insensitive) or UUIDs to group ids; an unknown name is a UserError. */
export async function resolveNodeGroupIds(db: Db, orgId: string, refs: string[]): Promise<string[]> {
	const ids: string[] = [];
	for (const raw of refs) {
		const ref = raw.trim();
		let row: { id: string } | undefined;
		if (isUuid(ref)) {
			row = await db
				.selectFrom("node_groups")
				.select("id")
				.where("org_id", "=", orgId)
				.where("id", "=", ref)
				.executeTakeFirst();
		}
		if (!row) {
			row = await db
				.selectFrom("node_groups")
				.select("id")
				.where("org_id", "=", orgId)
				.where("name_key", "=", nameKey(ref))
				.executeTakeFirst();
		}
		if (!row) throw new UserError(`no node group ${ref}`);
		if (!ids.includes(row.id)) ids.push(row.id);
	}
	return ids;
}

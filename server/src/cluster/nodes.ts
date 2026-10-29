import { factsFromJson } from "@crh/protocol/wire";
import type { Selectable } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { NodesTable, SharesTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";
import { uniqueNodeName } from "./enrollment.ts";
import { keyFingerprint } from "./identity.ts";

export type NodeRow = Selectable<NodesTable>;
export type NodeAccess = "admin" | "owner" | "operate" | "view";
export type ShareAccess = "view" | "operate";
export type GranteeType = "user" | "user_group";

export interface PublicNode {
	id: string;
	name: string;
	transport: NodesTable["transport"];
	status: NodesTable["status"];
	hostname: string | null;
	ownerUserId: string;
	clientVersion: string | null;
	privilegedMode: string | null;
	lastSeenAt: string | null;
	createdAt: string;
	approvedAt: string | null;
	groups: string[];
	access: NodeAccess;
	facts: unknown;
	/** base64url(SHA-256(public key)), as printed by `crha enroll` and `crha status`. */
	keyFingerprint: string | null;
	/** Whether crha is connected right now; null for SSH nodes, which connect per task. Set by the API layer. */
	connected: boolean | null;
}

export interface NodeShare {
	id: string;
	nodeId: string;
	granteeType: GranteeType;
	granteeId: string;
	/** Username or user group name, for display. */
	granteeName: string | null;
	access: ShareAccess;
	createdByUserId: string;
	createdAt: string;
}

export async function getNode(db: Db, id: string): Promise<NodeRow | undefined> {
	return db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function findNodeByPublicKey(db: Db, publicKey: Uint8Array): Promise<NodeRow | undefined> {
	return db
		.selectFrom("nodes")
		.selectAll()
		.where("public_key", "=", Buffer.from(publicKey).toString("base64"))
		.executeTakeFirst();
}

const RANK: Record<ShareAccess, number> = { view: 1, operate: 2 };

function stronger(a: ShareAccess | undefined, b: ShareAccess): ShareAccess {
	return a === undefined || RANK[b] > RANK[a] ? b : a;
}

async function userGroupIds(db: Db, userId: string): Promise<string[]> {
	const rows = await db.selectFrom("user_group_members").select("group_id").where("user_id", "=", userId).execute();
	return rows.map((r) => r.group_id);
}

/** The shares that reach the user directly or through a group, as nodeId -> strongest access. */
async function sharedAccess(db: Db, userId: string, nodeId?: string): Promise<Map<string, ShareAccess>> {
	const groupIds = await userGroupIds(db, userId);
	let q = db
		.selectFrom("shares")
		.select(["resource_id", "access"])
		.where("resource_type", "=", "node")
		.where((eb) =>
			groupIds.length > 0
				? eb.or([
						eb.and([eb("grantee_type", "=", "user"), eb("grantee_id", "=", userId)]),
						eb.and([eb("grantee_type", "=", "user_group"), eb("grantee_id", "in", groupIds)]),
					])
				: eb.and([eb("grantee_type", "=", "user"), eb("grantee_id", "=", userId)]),
		);
	if (nodeId) q = q.where("resource_id", "=", nodeId);
	const out = new Map<string, ShareAccess>();
	for (const r of await q.execute()) {
		if (r.access === "view" || r.access === "operate")
			out.set(r.resource_id, stronger(out.get(r.resource_id), r.access));
	}
	return out;
}

export async function nodeAccess(db: Db, user: SessionUser, nodeId: string): Promise<NodeAccess | undefined> {
	const node = await db.selectFrom("nodes").select("owner_user_id").where("id", "=", nodeId).executeTakeFirst();
	if (!node) return undefined;
	if (user.kind === "admin") return "admin";
	if (node.owner_user_id === user.userId) return "owner";
	return (await sharedAccess(db, user.userId, nodeId)).get(nodeId);
}

export function toPublicNode(row: NodeRow, access: NodeAccess, groups: string[]): PublicNode {
	let facts: unknown = null;
	if (row.facts !== null) {
		try {
			facts = factsFromJson(JSON.parse(row.facts));
		} catch {}
	}
	return {
		id: row.id,
		name: row.name,
		transport: row.transport,
		status: row.status,
		hostname: row.hostname,
		ownerUserId: row.owner_user_id,
		clientVersion: row.client_version,
		privilegedMode: row.privileged_mode,
		lastSeenAt: row.last_seen_at,
		createdAt: row.created_at,
		approvedAt: row.approved_at,
		groups,
		access,
		facts,
		keyFingerprint: row.public_key ? keyFingerprint(Buffer.from(row.public_key, "base64")) : null,
		connected: row.transport === "ssh" ? null : false,
	};
}

export async function nodeGroupNames(db: Db, nodeIds: string[]): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	if (nodeIds.length === 0) return out;
	const rows = await db
		.selectFrom("node_groups")
		.select(["node_id", "group_name"])
		.where("node_id", "in", nodeIds)
		.orderBy("group_name")
		.execute();
	for (const r of rows) out.set(r.node_id, [...(out.get(r.node_id) ?? []), r.group_name]);
	return out;
}

export async function listNodesForUser(db: Db, user: SessionUser): Promise<PublicNode[]> {
	let rows: NodeRow[];
	let shared = new Map<string, ShareAccess>();
	if (user.kind === "admin") {
		rows = await db.selectFrom("nodes").selectAll().orderBy("name").execute();
	} else {
		shared = await sharedAccess(db, user.userId);
		const ids = [...shared.keys()];
		rows = await db
			.selectFrom("nodes")
			.selectAll()
			.where((eb) =>
				ids.length > 0
					? eb.or([eb("owner_user_id", "=", user.userId), eb("id", "in", ids)])
					: eb("owner_user_id", "=", user.userId),
			)
			.orderBy("name")
			.execute();
	}
	const groups = await nodeGroupNames(
		db,
		rows.map((r) => r.id),
	);
	return rows.map((row) => {
		const access: NodeAccess =
			user.kind === "admin" ? "admin" : row.owner_user_id === user.userId ? "owner" : (shared.get(row.id) ?? "view");
		return toPublicNode(row, access, groups.get(row.id) ?? []);
	});
}

export async function approveNode(db: Db, nodeId: string, actorUserId: string, now = new Date()): Promise<NodeRow> {
	const result = await db
		.updateTable("nodes")
		.set({ status: "active", approved_at: now.toISOString(), approved_by_user_id: actorUserId })
		.where("id", "=", nodeId)
		.where("status", "=", "pending")
		.executeTakeFirst();
	if (result.numUpdatedRows !== 1n) {
		if (!(await getNode(db, nodeId))) throw new NotFoundError("no such node");
		throw new UserError("node is not pending");
	}
	return db.selectFrom("nodes").selectAll().where("id", "=", nodeId).executeTakeFirstOrThrow();
}

export async function renameNode(db: Db, nodeId: string, name: string): Promise<NodeRow> {
	const node = await getNode(db, nodeId);
	if (!node) throw new NotFoundError("no such node");
	const normalized = name.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(normalized)) {
		throw new UserError(
			"node name must be 1-63 characters of a-z, 0-9, '.', '_' or '-', starting with a letter or digit",
		);
	}
	if ((await uniqueNodeName(db, node.org_id, normalized, nodeId)) !== normalized) {
		throw new UserError(`node ${normalized} already exists`);
	}
	await db.updateTable("nodes").set({ name: normalized }).where("id", "=", nodeId).execute();
	return { ...node, name: normalized };
}

export async function deleteNode(db: Db, nodeId: string): Promise<void> {
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("shares").where("resource_type", "=", "node").where("resource_id", "=", nodeId).execute();
		await trx.deleteFrom("node_groups").where("node_id", "=", nodeId).execute();
		await trx
			.updateTable("enrollment_tokens")
			.set({ used_by_node_id: null })
			.where("used_by_node_id", "=", nodeId)
			.execute();
		const result = await trx.deleteFrom("nodes").where("id", "=", nodeId).executeTakeFirst();
		if (result.numDeletedRows === 0n) throw new NotFoundError("no such node");
	});
}

export async function updateNodeFacts(
	db: Db,
	nodeId: string,
	input: { facts: unknown; groups: string[]; clientVersion?: string; privilegedMode?: string; now?: Date },
): Promise<void> {
	const now = (input.now ?? new Date()).toISOString();
	await db.transaction().execute(async (trx) => {
		const set: Partial<Pick<NodesTable, "facts" | "last_seen_at" | "client_version" | "privileged_mode">> = {
			facts: JSON.stringify(input.facts ?? null),
			last_seen_at: now,
		};
		if (input.clientVersion !== undefined) set.client_version = input.clientVersion;
		if (input.privilegedMode !== undefined) set.privileged_mode = input.privilegedMode;
		const result = await trx.updateTable("nodes").set(set).where("id", "=", nodeId).executeTakeFirst();
		if (result.numUpdatedRows === 0n) throw new NotFoundError("no such node");
		await trx.deleteFrom("node_groups").where("node_id", "=", nodeId).execute();
		const names = [...new Set(input.groups)];
		if (names.length > 0) {
			await trx
				.insertInto("node_groups")
				.values(names.map((group_name) => ({ node_id: nodeId, group_name, refreshed_at: now })))
				.execute();
		}
	});
}

export async function markNodeSeen(db: Db, nodeId: string, now = new Date()): Promise<void> {
	await db.updateTable("nodes").set({ last_seen_at: now.toISOString() }).where("id", "=", nodeId).execute();
}

function toNodeShare(row: Selectable<SharesTable>, granteeName: string | null = null): NodeShare {
	return {
		id: row.id,
		nodeId: row.resource_id,
		granteeType: row.grantee_type,
		granteeId: row.grantee_id,
		granteeName,
		access: row.access as ShareAccess,
		createdByUserId: row.created_by_user_id,
		createdAt: row.created_at,
	};
}

export async function shareNode(
	db: Db,
	input: { nodeId: string; granteeType: GranteeType; granteeId: string; access: ShareAccess; createdBy: string },
): Promise<NodeShare> {
	if (input.granteeType !== "user" && input.granteeType !== "user_group") {
		throw new UserError("granteeType must be user or user_group");
	}
	if (input.access !== "view" && input.access !== "operate") throw new UserError("access must be view or operate");
	return db.transaction().execute(async (trx) => {
		const node = await trx.selectFrom("nodes").select("org_id").where("id", "=", input.nodeId).executeTakeFirst();
		if (!node) throw new NotFoundError("no such node");
		const grantee = await trx
			.selectFrom(input.granteeType === "user" ? "users" : "user_groups")
			.select("id")
			.where("id", "=", input.granteeId)
			.executeTakeFirst();
		if (!grantee) throw new NotFoundError(input.granteeType === "user" ? "no such user" : "no such user group");

		const existing = await trx
			.selectFrom("shares")
			.selectAll()
			.where("resource_type", "=", "node")
			.where("resource_id", "=", input.nodeId)
			.where("grantee_type", "=", input.granteeType)
			.where("grantee_id", "=", input.granteeId)
			.executeTakeFirst();
		if (existing) {
			await trx.updateTable("shares").set({ access: input.access }).where("id", "=", existing.id).execute();
			return toNodeShare({ ...existing, access: input.access });
		}
		const row: Selectable<SharesTable> = {
			id: newId(),
			org_id: node.org_id,
			resource_type: "node",
			resource_id: input.nodeId,
			grantee_type: input.granteeType,
			grantee_id: input.granteeId,
			access: input.access,
			created_by_user_id: input.createdBy,
			created_at: new Date().toISOString(),
		};
		await trx.insertInto("shares").values(row).execute();
		return toNodeShare(row);
	});
}

export async function unshareNode(db: Db, nodeId: string, shareId: string): Promise<void> {
	const result = await db
		.deleteFrom("shares")
		.where("id", "=", shareId)
		.where("resource_type", "=", "node")
		.where("resource_id", "=", nodeId)
		.executeTakeFirst();
	if (result.numDeletedRows === 0n) throw new NotFoundError("no such share");
}

export async function listNodeShares(db: Db, nodeId: string): Promise<NodeShare[]> {
	const rows = await db
		.selectFrom("shares")
		.selectAll()
		.where("resource_type", "=", "node")
		.where("resource_id", "=", nodeId)
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
		toNodeShare(r, (r.grantee_type === "user" ? users.get(r.grantee_id) : groups.get(r.grantee_id)) ?? null),
	);
}

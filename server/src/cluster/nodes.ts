import type { PublicNode } from "@crh/api";
import { factsFromJson, type JsonFacts } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { NodesTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { keyFingerprint } from "./identity.ts";
import { assertNameAvailable, nameKey, validateName } from "./names.ts";
import { accessibleNodeIds, deleteGrantsForNode, type NodeAccess } from "./node-access.ts";
import { type NodeGroupRef, nodeGroupsForNodes } from "./node-groups.ts";
import { type TrustWarning, trustWarningsForRows } from "./trust-warnings.ts";

export type NodeRow = Selectable<NodesTable>;
export { type NodeAccess, nodeAccess } from "./node-access.ts";
export type { PublicNode };

/**
 * A warning line when a node's clock differs from crhs's by more than `warnMs`
 * (doc/privilege.md#时钟); 0 turns the warning off. `facts` is the JSON form of the node's Facts.
 */
export function clockWarning(facts: unknown, warnMs: number): string | null {
	if (warnMs <= 0) return null;
	const offset = (facts as { clockOffsetMs?: unknown } | null)?.clockOffsetMs;
	if (typeof offset !== "number" || !Number.isFinite(offset) || Math.abs(offset) <= warnMs) return null;
	const ms = Math.abs(offset);
	const seconds = ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1);
	return `the node's clock differs from crhs by ${seconds} s`;
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

export function toPublicNode(
	row: NodeRow,
	access: NodeAccess,
	nodeGroups: NodeGroupRef[],
	trustWarnings: TrustWarning[] = [],
): PublicNode {
	let facts: JsonFacts | null = null;
	if (row.facts !== null) {
		try {
			// A stored row may be partial: an SSH node keeps only the shells its connection probe found,
			// and a row written before a fact existed lacks it (doc/protocol.md Facts).
			facts = factsFromJson(JSON.parse(row.facts));
		} catch {}
	}
	return {
		id: row.id,
		name: row.name,
		transport: row.transport,
		status: row.status,
		hostname: row.hostname,
		clientVersion: row.client_version,
		privilegedMode: row.privileged_mode,
		lastSeenAt: row.last_seen_at,
		createdAt: row.created_at,
		approvedAt: row.approved_at,
		nodeGroups,
		access,
		facts,
		keyFingerprint: row.public_key ? keyFingerprint(Buffer.from(row.public_key, "base64")) : null,
		connected: row.transport === "ssh" ? null : false,
		clockWarning: null,
		trustWarnings,
	};
}

/** The ids of every node the user can see: all of them as admin, otherwise the granted set (D108). */
export async function visibleNodeIds(db: Db, user: SessionUser): Promise<string[]> {
	return accessibleNodeIds(db, user);
}

export async function listNodesForUser(
	db: Db,
	user: SessionUser,
	options: { crhsFingerprint?: string } = {},
): Promise<PublicNode[]> {
	const ids = await visibleNodeIds(db, user);
	if (ids.length === 0) return [];
	const rows = await db.selectFrom("nodes").selectAll().where("id", "in", ids).orderBy("name").execute();
	const nodeGroups = await nodeGroupsForNodes(
		db,
		rows.map((r) => r.id),
	);
	// One context for the whole listing: the node groups and registered credentials are loaded once.
	const warnings = await trustWarningsForRows(db, rows, nodeGroups, options);
	return rows.map((row) =>
		toPublicNode(
			row,
			user.kind === "admin" ? "admin" : "granted",
			nodeGroups.get(row.id) ?? [],
			warnings.get(row.id) ?? [],
		),
	);
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

export async function renameNode(db: Db, nodeId: string, rawName: string): Promise<NodeRow> {
	const name = validateName(rawName, "node name");
	return db.transaction().execute(async (trx) => {
		const node = await trx.selectFrom("nodes").selectAll().where("id", "=", nodeId).executeTakeFirst();
		if (!node) throw new NotFoundError("no such node");
		await assertNameAvailable(trx, node.org_id, name, { table: "nodes", id: node.id });
		await trx
			.updateTable("nodes")
			.set({ name, name_key: nameKey(name) })
			.where("id", "=", nodeId)
			.execute();
		return { ...node, name, name_key: nameKey(name) };
	});
}

export async function deleteNode(db: Db, nodeId: string): Promise<void> {
	await db.transaction().execute(async (trx) => {
		await deleteGrantsForNode(trx, nodeId);
		await trx.deleteFrom("node_group_members").where("node_id", "=", nodeId).execute();
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
	input: { facts: unknown; clientVersion?: string; privilegedMode?: string; now?: Date },
): Promise<void> {
	const now = (input.now ?? new Date()).toISOString();
	const set: Partial<Pick<NodesTable, "facts" | "last_seen_at" | "client_version" | "privileged_mode">> = {
		facts: JSON.stringify(input.facts ?? null),
		last_seen_at: now,
	};
	if (input.clientVersion !== undefined) set.client_version = input.clientVersion;
	if (input.privilegedMode !== undefined) set.privileged_mode = input.privilegedMode;
	await db.transaction().execute(async (trx) => {
		const result = await trx.updateTable("nodes").set(set).where("id", "=", nodeId).executeTakeFirst();
		if (result.numUpdatedRows === 0n) throw new NotFoundError("no such node");
	});
}

/**
 * Records the shells an SSH connection probe found (doc/execution-plane.md#执行). SSH nodes have no
 * other facts; their node groups are maintained by crhs and are left alone.
 */
export async function setSshNodeFacts(
	db: Db,
	nodeId: string,
	shells: { sh: string; bash: string | null },
): Promise<void> {
	// No bash is an absent fact, not a null one (doc/protocol.md Facts).
	const { bash } = shells;
	await db
		.updateTable("nodes")
		.set({ facts: JSON.stringify({ shells: bash === null ? { sh: shells.sh } : shells }) })
		.where("id", "=", nodeId)
		.execute();
}

export async function markNodeSeen(db: Db, nodeId: string, now = new Date()): Promise<void> {
	await db.updateTable("nodes").set({ last_seen_at: now.toISOString() }).where("id", "=", nodeId).execute();
}

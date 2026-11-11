import type { PublicNode } from "@crh/api";
import { factsFromJson, type JsonFacts } from "@crh/protocol";
import type { Selectable } from "kysely";
import { isAdmin, type SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import type { NodesTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import {
	likeContains,
	lowerCase,
	parseListQuery,
	prefixRank,
	type RawEntityListQuery,
	textMatches,
} from "../util/list-query.ts";
import { assertNameAvailable, nameKey, validateName } from "../util/names.ts";
import { keyFingerprint } from "./identity.ts";
import { accessibleNodeIds, deleteGrantsForNode, type NodeAccess } from "./node-access.ts";
import { type NodeGroupRef, nodeGroupsForNodes } from "./node-groups.ts";
import { type TrustWarning, trustWarningsForRows } from "./trust-warnings.ts";

export type NodeRow = Selectable<NodesTable>;
export { type NodeAccess, nodeAccess } from "./node-access.ts";
export type { PublicNode };

/**
 * The measured clock offset when a node's clock differs from crhs's by more than
 * `warnMs` (doc/design/privilege.md "Clock"); 0 turns the warning off. `facts` is the JSON form of the
 * node's Facts. The offset is signed (local clock minus crhs); the web UI localizes the text.
 */
export function nodeClockWarning(facts: unknown, warnMs: number): { offsetMs: number; thresholdMs: number } | null {
	if (warnMs <= 0) return null;
	const offset = (facts as { clockOffsetMs?: unknown } | null)?.clockOffsetMs;
	if (typeof offset !== "number" || !Number.isFinite(offset) || Math.abs(offset) <= warnMs) return null;
	return { offsetMs: offset, thresholdMs: warnMs };
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
			// and a row written before a fact existed lacks it (doc/design/protocol.md "Events").
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

/** The ids of every node the user can see: all of them as admin, otherwise the granted set. */
export async function visibleNodeIds(db: Db, user: SessionUser): Promise<string[]> {
	return accessibleNodeIds(db, user);
}

/** One searchable list page (see `queryUsers`). */
export interface NodeListPage {
	items: PublicNode[];
	more: boolean;
}

/**
 * `GET /api/nodes` with the optional search parameters (doc/design/webui.md "Entity search").
 * Visibility is unchanged: the query is restricted to the ids `visibleNodeIds` returns,
 * so a search or an `ids` lookup can never name a node the caller cannot see.
 */
export async function queryNodesForUser(
	db: Db,
	user: SessionUser,
	params: RawEntityListQuery,
	options: { crhsFingerprints?: readonly string[] } = {},
): Promise<NodeListPage> {
	const query = parseListQuery(params);
	const visible = await visibleNodeIds(db, user);
	if (visible.length === 0 || query.ids?.length === 0) return { items: [], more: false };
	let select = db.selectFrom("nodes").selectAll().where("id", "in", visible);
	if (query.ids !== undefined) select = select.where("id", "in", query.ids);
	if (query.q !== undefined) {
		select = select
			.where(textMatches(["name", "hostname"], likeContains(query.q)))
			.orderBy(prefixRank(["name", "hostname"], query.q))
			.orderBy(lowerCase("name"))
			.orderBy("id");
	} else {
		select = select.orderBy("name");
	}
	if (query.limit !== undefined) select = select.limit(query.limit + 1);
	const rows = await select.execute();
	const more = query.limit !== undefined && rows.length > query.limit;
	const page = rows.slice(0, query.limit ?? rows.length);
	const nodeGroups = await nodeGroupsForNodes(
		db,
		page.map((r) => r.id),
	);
	// One context for the whole listing: the node groups and registered credentials are loaded once.
	const warnings = await trustWarningsForRows(db, page, nodeGroups, options);
	return {
		items: page.map((row) =>
			toPublicNode(row, isAdmin(user) ? "admin" : "granted", nodeGroups.get(row.id) ?? [], warnings.get(row.id) ?? []),
		),
		more,
	};
}

export async function listNodesForUser(
	db: Db,
	user: SessionUser,
	options: { crhsFingerprints?: readonly string[] } = {},
): Promise<PublicNode[]> {
	return (await queryNodesForUser(db, user, {}, options)).items;
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
		// A re-enrollment token dies with its node; a used ordinary token keeps its row but loses the reference.
		await trx.deleteFrom("enrollment_tokens").where("bound_node_id", "=", nodeId).execute();
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
 * Records the shells an SSH connection probe found (doc/design/execution.md "SSH execution"). SSH nodes have no
 * other facts; their node groups are maintained by crhs and are left alone.
 */
export async function setSshNodeFacts(
	db: Db,
	nodeId: string,
	shells: { sh: string; bash: string | null },
): Promise<void> {
	// No bash is an absent fact, not a null one (doc/design/protocol.md "Events").
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

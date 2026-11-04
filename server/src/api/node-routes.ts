import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import { createEnrollmentToken } from "../cluster/enrollment.ts";
import { nodeGroupsForNodes, resolveNodeGroupIds, setNodeGroupsForNode } from "../cluster/node-groups.ts";
import {
	approveNode,
	clockWarning,
	deleteNode,
	getNode,
	listNodesForUser,
	type NodeAccess,
	nodeAccess,
	type PublicNode,
	renameNode,
	toPublicNode,
} from "../cluster/nodes.ts";
import { sshNodeDetails } from "../cluster/ssh/nodes.ts";
import { trustView } from "../cluster/trust.ts";
import type { Db } from "../storage/db.ts";
import type { AppOptions } from "./app.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";

/** Expects requireUser to have run. */
export function nodeRoutes(db: Db, options: AppOptions = {}) {
	const app = new Hono<AppEnv>();

	/** The caller's access to the node, or undefined when the node is hidden from them. */
	const access = (c: { get(k: "user"): AppEnv["Variables"]["user"] }, id: string) => nodeAccess(db, c.get("user"), id);
	/** D108: only administrators manage nodes; a node they cannot see is still a 404. */
	const canManage = (a: NodeAccess, user: AppEnv["Variables"]["user"]) => user.kind === "admin" && a === "admin";

	const clockWarnMs = options.clockWarnMs ?? 60_000;

	/** Fills in what only the live server knows: the connection state and the clock warning. */
	const live = (n: PublicNode): PublicNode => ({
		...n,
		connected: n.connected === null ? null : (options.cluster?.isConnected(n.id) ?? false),
		clockWarning: clockWarning(n.facts, clockWarnMs),
	});

	app.get("/nodes", async (c) => c.json({ nodes: (await listNodesForUser(db, c.get("user"))).map(live) }));

	app.get("/nodes/:id", async (c) => {
		const id = c.req.param("id");
		const level = await access(c, id);
		const row = level ? await getNode(db, id) : undefined;
		if (!level || !row) return jsonError(c, 404, "no such node");
		const nodeGroups = (await nodeGroupsForNodes(db, [id])).get(id) ?? [];
		const node = live(toPublicNode(row, level, nodeGroups));
		if (!canManage(level, c.get("user"))) return c.json({ node });
		return c.json({ node, ssh: (await sshNodeDetails(db, row)) ?? null });
	});

	/** The node's trust panel (doc/privilege.md#信任缓存): the last TrustReport, its digest and its entries. */
	app.get("/nodes/:id/trust", async (c) => {
		const id = c.req.param("id");
		const level = await access(c, id);
		const row = level ? await getNode(db, id) : undefined;
		if (!level || !row) return jsonError(c, 404, "no such node");
		return c.json({ trust: trustView(row, options.cluster?.trustFresh(id) ?? false) });
	});

	app.post("/enrollment-tokens", async (c) => {
		if (c.get("user").kind !== "admin") return jsonError(c, 403, "administrators only");
		if (!options.serverFingerprint) return c.json({ error: "server fingerprint is not configured" }, 500);
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const created = await createEnrollmentToken(db, {
			userId: c.get("user").userId,
			nameHint: optionalString(body, "nameHint"),
			serverFingerprint: options.serverFingerprint,
		});
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "enrollment_token.created",
			target: { type: "enrollment_token", id: created.id },
			detail: { name_hint: optionalString(body, "nameHint"), expires_at: created.expiresAt },
		});
		return c.json({ token: created.token, expiresAt: created.expiresAt }, 201);
	});

	/** Resolves the node for a manage-only route: 404 when hidden, 403 for a non-administrator. */
	const manageable = async (c: Parameters<typeof access>[0], id: string) => {
		const level = await access(c, id);
		if (!level) return { error: { status: 404 as const, message: "no such node" } };
		if (!canManage(level, c.get("user"))) return { error: { status: 403 as const, message: "administrators only" } };
		return { level };
	};

	app.post("/nodes/:id/approve", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const row = await getNode(db, id);
		if (row?.status !== "pending") return jsonError(c, 409, "node is not pending");
		const node = await approveNode(db, id, c.get("user").userId);
		// The pending connection only carried facts; tell crha, then let it reconnect as an active node.
		options.cluster?.notifyNodeStatus(id, "active", "approved");
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.approved",
			target: { type: "node", id },
			detail: { name: node.name },
		});
		return c.json({ node: toPublicNode(node, m.level, (await nodeGroupsForNodes(db, [id])).get(id) ?? []) });
	});

	app.patch("/nodes/:id", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const body = await readJsonObject(c);
		const name = body ? optionalString(body, "name") : undefined;
		if (!name) return jsonError(c, 400, "name is required");
		const before = await getNode(db, id);
		const node = await renameNode(db, id, name);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.renamed",
			target: { type: "node", id },
			detail: { old_name: before?.name, new_name: node.name },
		});
		return c.json({ node: live(toPublicNode(node, m.level, (await nodeGroupsForNodes(db, [id])).get(id) ?? [])) });
	});

	/** Replaces a node's node groups; administrators only, for crha and SSH nodes alike (D108, D109). */
	app.put("/nodes/:id/node-groups", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const row = await getNode(db, id);
		if (!row) return jsonError(c, 404, "no such node");
		const body = await readJsonObject(c);
		const nodeGroups = body?.nodeGroups;
		if (!Array.isArray(nodeGroups) || !nodeGroups.every((group) => typeof group === "string")) {
			return jsonError(c, 400, "nodeGroups must be a list of node-group names or ids");
		}
		const nodeGroupIds = await resolveNodeGroupIds(db, row.org_id, nodeGroups);
		const current = await setNodeGroupsForNode(db, id, nodeGroupIds);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.node_groups_changed",
			target: { type: "node", id },
			detail: { node_group_ids: nodeGroupIds, node_groups: current.map((nodeGroup) => nodeGroup.name) },
		});
		return c.json({ nodeGroups: current });
	});

	app.delete("/nodes/:id", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const before = await getNode(db, id);
		await deleteNode(db, id);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.deleted",
			target: { type: "node", id },
			detail: { name: before?.name, was_pending: before?.status === "pending", rejected: before?.status === "pending" },
		});
		// Deleting a pending node rejects its enrollment; deleting an active node disconnects it. Both get
		// node.status{rejected} first, which tells crha to stop and not reconnect.
		options.cluster?.notifyNodeStatus(id, "rejected", "node deleted");
		return c.json({ ok: true });
	});

	return app;
}

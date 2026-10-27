import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import { createEnrollmentToken } from "../cluster/enrollment.ts";
import {
	approveNode,
	deleteNode,
	getNode,
	listNodeShares,
	listNodesForUser,
	type NodeAccess,
	nodeAccess,
	nodeGroupNames,
	type PublicNode,
	renameNode,
	shareNode,
	toPublicNode,
	unshareNode,
} from "../cluster/nodes.ts";
import { sshNodeDetails } from "../cluster/ssh/nodes.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import type { AppOptions } from "./app.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";

/** Expects requireUser to have run. */
export function nodeRoutes(db: Db, options: AppOptions = {}) {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError || err instanceof TypeError) return jsonError(c, 400, err.message);
		throw err;
	});

	/** The caller's access to the node, or undefined when the node is hidden from them. */
	const access = (c: { get(k: "user"): AppEnv["Variables"]["user"] }, id: string) => nodeAccess(db, c.get("user"), id);
	const canManage = (a: NodeAccess) => a === "owner" || a === "admin";

	const live = (n: PublicNode): PublicNode =>
		n.connected === null ? n : { ...n, connected: options.cluster?.isConnected(n.id) ?? false };

	app.get("/nodes", async (c) => c.json({ nodes: (await listNodesForUser(db, c.get("user"))).map(live) }));

	app.get("/nodes/:id", async (c) => {
		const id = c.req.param("id");
		const level = await access(c, id);
		const row = level ? await getNode(db, id) : undefined;
		if (!level || !row) return jsonError(c, 404, "no such node");
		const groups = (await nodeGroupNames(db, [id])).get(id) ?? [];
		const node = live(toPublicNode(row, level, groups));
		if (!canManage(level)) return c.json({ node });
		return c.json({ node, shares: await listNodeShares(db, id), ssh: (await sshNodeDetails(db, row)) ?? null });
	});

	app.post("/enrollment-tokens", async (c) => {
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

	/** Resolves the node for a manage-only route: 404 without access, 403 for shared users. */
	const manageable = async (c: Parameters<typeof access>[0], id: string) => {
		const level = await access(c, id);
		if (!level) return { error: { status: 404 as const, message: "no such node" } };
		if (!canManage(level))
			return { error: { status: 403 as const, message: "only the owner or an administrator can do this" } };
		return { level };
	};

	app.post("/nodes/:id/approve", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const row = await getNode(db, id);
		if (row?.status !== "pending") return jsonError(c, 409, "node is not pending");
		const node = await approveNode(db, id, c.get("user").userId);
		// The pending connection only carried facts; crha reconnects as an active node.
		options.cluster?.disconnect(id, "approved");
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.approved",
			target: { type: "node", id },
			detail: { name: node.name },
		});
		return c.json({ node: toPublicNode(node, m.level, (await nodeGroupNames(db, [id])).get(id) ?? []) });
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
		return c.json({ node: live(toPublicNode(node, m.level, (await nodeGroupNames(db, [id])).get(id) ?? [])) });
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
		options.cluster?.disconnect(id, "node deleted");
		return c.json({ ok: true });
	});

	app.put("/nodes/:id/shares", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const granteeType = optionalString(body, "granteeType");
		const granteeId = optionalString(body, "granteeId");
		const shareAccess = optionalString(body, "access");
		if (granteeType !== "user" && granteeType !== "user_group") {
			return jsonError(c, 400, "granteeType must be user or user_group");
		}
		if (!granteeId) return jsonError(c, 400, "granteeId is required");
		if (shareAccess !== "view" && shareAccess !== "operate") return jsonError(c, 400, "access must be view or operate");
		const share = await shareNode(db, {
			nodeId: id,
			granteeType,
			granteeId,
			access: shareAccess,
			createdBy: c.get("user").userId,
		});
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.shared",
			target: { type: "node", id },
			detail: { grantee_type: granteeType, grantee_id: granteeId, access: shareAccess },
		});
		return c.json({ share });
	});

	app.delete("/nodes/:id/shares/:shareId", async (c) => {
		const id = c.req.param("id");
		const m = await manageable(c, id);
		if (m.error) return jsonError(c, m.error.status, m.error.message);
		const share = (await listNodeShares(db, id)).find((s) => s.id === c.req.param("shareId"));
		await unshareNode(db, id, c.req.param("shareId"));
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node.unshared",
			target: { type: "node", id },
			detail: {
				share_id: c.req.param("shareId"),
				grantee_type: share?.granteeType,
				grantee_id: share?.granteeId,
				access: share?.access,
			},
		});
		return c.json({ ok: true });
	});

	return app;
}

import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import { isAdmin } from "../auth/sessions.ts";
import {
	createNodeGroup,
	deleteNodeGroup,
	getNodeGroup,
	queryNodeGroups,
	renameNodeGroup,
	setNodeGroupMembers,
} from "../cluster/node-groups.ts";
import { visibleNodeIds } from "../cluster/nodes.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

/**
 * Node groups: administrators manage them, every signed-in user may list them (doc/design/access-control.md "User types").
 * A non-admin's list only shows the member nodes they can see. Expects requireUser to have run.
 */
export function nodeGroupRoutes(db: Db) {
	const app = new Hono<AppEnv>();

	app.get("/node-groups", async (c) => {
		const user = c.get("user");
		const params = {
			q: c.req.query("q"),
			limit: c.req.query("limit"),
			ids: c.req.query("ids"),
		};
		const page = await queryNodeGroups(db, params);
		const more = params.limit === undefined ? {} : { more: page.more };
		if (isAdmin(user)) return c.json({ groups: page.items, ...more });
		const visible = new Set(await visibleNodeIds(db, user));
		return c.json({
			groups: page.items.map((group) => ({
				...group,
				memberIds: group.memberIds.filter((id) => visible.has(id)),
			})),
			...more,
		});
	});

	app.post("/node-groups", requireAdmin, async (c) => {
		const user = c.get("user");
		const body = await readJsonObject(c);
		const name = typeof body?.name === "string" ? body.name : "";
		const group = await createNodeGroup(db, await defaultOrgId(db), name);
		void c.get("audit").record({
			actor: userActor(user),
			action: "node_group.created",
			target: { type: "node_group", id: group.id },
			detail: { name: group.name },
		});
		return c.json({ group }, 201);
	});

	app.patch("/node-groups/:id", requireAdmin, async (c) => {
		const user = c.get("user");
		const id = c.req.param("id");
		const before = await getNodeGroup(db, id);
		if (!before) return jsonError(c, 404, "no such node group");
		const body = await readJsonObject(c);
		const name = typeof body?.name === "string" ? body.name : "";
		const group = await renameNodeGroup(db, id, name);
		void c.get("audit").record({
			actor: userActor(user),
			action: "node_group.renamed",
			target: { type: "node_group", id },
			detail: { old_name: before.name, new_name: group.name },
		});
		return c.json({ group });
	});

	app.delete("/node-groups/:id", requireAdmin, async (c) => {
		const user = c.get("user");
		const id = c.req.param("id");
		const before = await getNodeGroup(db, id);
		if (!before) return jsonError(c, 404, "no such node group");
		await deleteNodeGroup(db, id);
		void c.get("audit").record({
			actor: userActor(user),
			action: "node_group.deleted",
			target: { type: "node_group", id },
			detail: { name: before.name, member_ids: before.memberIds },
		});
		return c.json({ ok: true });
	});

	app.put("/node-groups/:id/members", requireAdmin, async (c) => {
		const user = c.get("user");
		const id = c.req.param("id");
		const before = await getNodeGroup(db, id);
		if (!before) return jsonError(c, 404, "no such node group");
		const body = await readJsonObject(c);
		const nodeIds = body?.nodeIds;
		if (!Array.isArray(nodeIds) || !nodeIds.every((nodeId) => typeof nodeId === "string")) {
			return jsonError(c, 400, "nodeIds must be a list of node ids");
		}
		const group = await setNodeGroupMembers(db, id, nodeIds);
		void c.get("audit").record({
			actor: userActor(user),
			action: "node_group.members_changed",
			target: { type: "node_group", id },
			detail: {
				added: group.memberIds.filter((nodeId) => !before.memberIds.includes(nodeId)),
				removed: before.memberIds.filter((nodeId) => !group.memberIds.includes(nodeId)),
			},
		});
		return c.json({ group });
	});

	return app;
}

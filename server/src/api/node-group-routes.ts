import {
	IdParamSchema,
	NodeGroupListQuerySchema,
	NodeGroupListResponseSchema,
	NodeGroupMembersBodySchema,
	NodeGroupNameBodySchema,
	NodeGroupResponseSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
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
import { NotFoundError } from "../util/errors.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Node groups"];

const listRoute = defineRoute({
	method: "get",
	path: "/node-groups",
	tags: TAGS,
	summary: "List node groups; a non-administrator sees only the member nodes they can access",
	agent: "allow",
	request: { query: NodeGroupListQuerySchema },
	responses: { 200: { description: "The groups", ...json(NodeGroupListResponseSchema) } },
});

const createGroupRoute = defineRoute({
	method: "post",
	path: "/node-groups",
	tags: TAGS,
	summary: "Create an empty node group (administrators)",
	agent: "ask",
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(NodeGroupNameBodySchema) } },
	responses: { 201: { description: "The new group", ...json(NodeGroupResponseSchema) } },
});

const renameRoute = defineRoute({
	method: "patch",
	path: "/node-groups/{id}",
	tags: TAGS,
	summary: "Rename a node group (administrators)",
	agent: "ask",
	middleware: [requireAdmin],
	request: { params: IdParamSchema, body: { required: true, ...json(NodeGroupNameBodySchema) } },
	responses: { 200: { description: "The renamed group", ...json(NodeGroupResponseSchema) } },
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/node-groups/{id}",
	tags: TAGS,
	summary: "Delete a node group; its nodes stay (administrators)",
	agent: "ask",
	middleware: [requireAdmin],
	request: { params: IdParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

const membersRoute = defineRoute({
	method: "put",
	path: "/node-groups/{id}/members",
	tags: TAGS,
	summary: "Replace a node group's member list (administrators)",
	agent: "deny", // membership widens node access through grants on the group
	middleware: [requireAdmin],
	request: { params: IdParamSchema, body: { required: true, ...json(NodeGroupMembersBodySchema) } },
	responses: { 200: { description: "The group with its new members", ...json(NodeGroupResponseSchema) } },
});

/**
 * Node groups: administrators manage them, every signed-in user may list them (doc/design/access-control.md "User types").
 * A non-admin's list only shows the member nodes they can see. Expects requireUser to have run.
 */
export function nodeGroupRoutes(db: Db) {
	const app = apiRouter();

	app.openapi(listRoute, async (c) => {
		const user = c.get("user");
		const params = c.req.valid("query");
		const page = await queryNodeGroups(db, params);
		const more = params.limit === undefined ? {} : { more: page.more };
		if (isAdmin(user)) return c.json({ groups: page.items, ...more }, 200);
		const visible = new Set(await visibleNodeIds(db, user));
		return c.json(
			{
				groups: page.items.map((group) => ({
					...group,
					memberIds: group.memberIds.filter((id) => visible.has(id)),
				})),
				...more,
			},
			200,
		);
	});

	app.openapi(createGroupRoute, async (c) => {
		const user = c.get("user");
		const { name } = c.req.valid("json");
		const group = await createNodeGroup(db, await defaultOrgId(db), name);
		void c.get("audit").record({
			actor: userActor(user),
			action: "node_group.created",
			target: { type: "node_group", id: group.id },
			detail: { name: group.name },
		});
		return c.json({ group }, 201);
	});

	app.openapi(renameRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const before = await getNodeGroup(db, id);
		if (!before) throw new NotFoundError("no such node group");
		const { name } = c.req.valid("json");
		const group = await renameNodeGroup(db, id, name);
		void c.get("audit").record({
			actor: userActor(user),
			action: "node_group.renamed",
			target: { type: "node_group", id },
			detail: { old_name: before.name, new_name: group.name },
		});
		return c.json({ group }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const before = await getNodeGroup(db, id);
		if (!before) throw new NotFoundError("no such node group");
		await deleteNodeGroup(db, id);
		void c.get("audit").record({
			actor: userActor(user),
			action: "node_group.deleted",
			target: { type: "node_group", id },
			detail: { name: before.name, member_ids: before.memberIds },
		});
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(membersRoute, async (c) => {
		const user = c.get("user");
		const { id } = c.req.valid("param");
		const before = await getNodeGroup(db, id);
		if (!before) throw new NotFoundError("no such node group");
		const { nodeIds } = c.req.valid("json");
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
		return c.json({ group }, 200);
	});

	return app;
}

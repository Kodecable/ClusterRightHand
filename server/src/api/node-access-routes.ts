import {
	ErrorResponseSchema,
	IdParamSchema,
	NodeAccessGrantFilterSchema,
	NodeAccessGrantInputSchema,
	NodeAccessGrantListResponseSchema,
	NodeAccessGrantResponseSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import {
	createNodeAccessGrant,
	DuplicateGrantError,
	deleteNodeAccessGrant,
	getNodeAccessGrant,
	listNodeAccessGrants,
	type NodeAccessGrant,
} from "../cluster/node-access.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import { NotFoundError } from "../util/errors.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Node access"];

const listRoute = defineRoute({
	method: "get",
	path: "/node-access-grants",
	tags: TAGS,
	summary: "List node access grants, optionally only those of one grantee or target (administrators)",
	agent: "allow",
	middleware: [requireAdmin],
	request: { query: NodeAccessGrantFilterSchema },
	responses: { 200: { description: "The matching grants", ...json(NodeAccessGrantListResponseSchema) } },
});

const createRoute = defineRoute({
	method: "post",
	path: "/node-access-grants",
	tags: TAGS,
	summary: "Grant a user or user group access to a node or a node group (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { body: { required: true, ...json(NodeAccessGrantInputSchema) } },
	responses: {
		201: { description: "The new grant", ...json(NodeAccessGrantResponseSchema) },
		409: { description: "The same grant already exists", ...json(ErrorResponseSchema) },
	},
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/node-access-grants/{id}",
	tags: TAGS,
	summary: "Delete a node access grant (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: IdParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

/**
 * Node access grants (doc/design/access-control.md "Ownership, access grants and sharing"): administrators list, create and delete
 * them. A grantee (user or user group) reaches a node or every current member of a node group; there is one
 * access level. A duplicate grant is a 409, so a retry does not claim to have created another one.
 * Expects requireUser to have run.
 */
export function nodeAccessRoutes(db: Db) {
	const app = apiRouter();

	app.openapi(listRoute, async (c) => {
		const q = c.req.valid("query");
		const grants = await listNodeAccessGrants(db, {
			targetType: q.targetType,
			targetId: q.targetId || undefined,
			granteeType: q.granteeType,
			granteeId: q.granteeId || undefined,
		});
		return c.json({ grants }, 200);
	});

	app.openapi(createRoute, async (c) => {
		const body = c.req.valid("json");
		const orgId = await defaultOrgId(db);
		let grant: NodeAccessGrant;
		try {
			grant = await createNodeAccessGrant(db, {
				orgId,
				granteeType: body.granteeType,
				granteeId: body.granteeId,
				targetType: body.targetType,
				targetId: body.targetId,
				createdByUserId: c.get("user").userId,
			});
		} catch (err) {
			// A duplicate is a conflict, not a bad request: the same grant already exists.
			if (err instanceof DuplicateGrantError) throw new HTTPException(409, { message: err.message });
			throw err;
		}
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node_access_grant.created",
			target: { type: "node_access_grant", id: grant.id },
			detail: {
				grantee_type: grant.granteeType,
				grantee_id: grant.granteeId,
				grantee_name: grant.granteeName,
				target_type: grant.targetType,
				target_id: grant.targetId,
				target_name: grant.targetName,
			},
		});
		return c.json({ grant }, 201);
	});

	app.openapi(deleteRoute, async (c) => {
		const { id } = c.req.valid("param");
		const grant = await getNodeAccessGrant(db, id);
		if (!grant) throw new NotFoundError("no such grant");
		await deleteNodeAccessGrant(db, id);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "node_access_grant.deleted",
			target: { type: "node_access_grant", id },
			detail: {
				grantee_type: grant.granteeType,
				grantee_id: grant.granteeId,
				grantee_name: grant.granteeName,
				target_type: grant.targetType,
				target_id: grant.targetId,
				target_name: grant.targetName,
			},
		});
		return c.json({ ok: true as const }, 200);
	});

	return app;
}

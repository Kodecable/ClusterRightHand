import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import {
	type AccessTargetType,
	createNodeAccessGrant,
	DuplicateGrantError,
	deleteNodeAccessGrant,
	type GranteeType,
	getNodeAccessGrant,
	listNodeAccessGrants,
	type NodeAccessGrant,
} from "../cluster/node-access.ts";
import type { Db } from "../storage/db.ts";
import { defaultOrgId } from "../storage/org.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

const GRANTEE_TYPES: ReadonlySet<string> = new Set<GranteeType>(["user", "user_group"]);
const TARGET_TYPES: ReadonlySet<string> = new Set<AccessTargetType>(["node", "node_group"]);

/**
 * Node access grants (doc/design/access-control.md "Ownership, access grants and sharing"): administrators list, create and delete
 * them. A grantee (user or user group) reaches a node or every current member of a node group; there is one
 * access level. A duplicate grant is a 409, so a retry does not claim to have created another one.
 * Expects requireUser to have run.
 */
export function nodeAccessRoutes(db: Db) {
	const app = new Hono<AppEnv>();

	app.use("/node-access-grants/*", requireAdmin);
	app.use("/node-access-grants", requireAdmin);

	app.get("/node-access-grants", async (c) => {
		const targetType = c.req.query("targetType");
		const granteeType = c.req.query("granteeType");
		if (targetType !== undefined && !TARGET_TYPES.has(targetType)) {
			return jsonError(c, 400, "targetType must be node or node_group");
		}
		if (granteeType !== undefined && !GRANTEE_TYPES.has(granteeType)) {
			return jsonError(c, 400, "granteeType must be user or user_group");
		}
		const grants = await listNodeAccessGrants(db, {
			targetType: targetType as AccessTargetType | undefined,
			targetId: c.req.query("targetId") || undefined,
			granteeType: granteeType as GranteeType | undefined,
			granteeId: c.req.query("granteeId") || undefined,
		});
		return c.json({ grants });
	});

	app.post("/node-access-grants", async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const granteeType = body.granteeType;
		const granteeId = body.granteeId;
		const targetType = body.targetType;
		const targetId = body.targetId;
		if (typeof granteeType !== "string" || !GRANTEE_TYPES.has(granteeType)) {
			return jsonError(c, 400, "granteeType must be user or user_group");
		}
		if (typeof targetType !== "string" || !TARGET_TYPES.has(targetType)) {
			return jsonError(c, 400, "targetType must be node or node_group");
		}
		if (typeof granteeId !== "string" || granteeId === "") return jsonError(c, 400, "granteeId is required");
		if (typeof targetId !== "string" || targetId === "") return jsonError(c, 400, "targetId is required");
		const orgId = await defaultOrgId(db);
		let grant: NodeAccessGrant;
		try {
			grant = await createNodeAccessGrant(db, {
				orgId,
				granteeType: granteeType as GranteeType,
				granteeId,
				targetType: targetType as AccessTargetType,
				targetId,
				createdByUserId: c.get("user").userId,
			});
		} catch (err) {
			// A duplicate is a conflict, not a bad request: the same grant already exists.
			if (err instanceof DuplicateGrantError) return jsonError(c, 409, err.message);
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

	app.delete("/node-access-grants/:id", async (c) => {
		const id = c.req.param("id");
		const grant = await getNodeAccessGrant(db, id);
		if (!grant) return jsonError(c, 404, "no such grant");
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
		return c.json({ ok: true });
	});

	return app;
}

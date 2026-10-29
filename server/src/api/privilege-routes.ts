import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import { NotFoundError } from "../users/service.ts";
import { type AppEnv, jsonError } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

export interface PrivilegeRoutesOptions {
	cluster?: Cluster;
	/** crhs's authorization signing key; without it there is nothing to export. */
	authorizationKey?: AuthorizationSigningKey;
}

/** Expects requireUser to have run. Authorizations and the crhs signing key (doc/privilege.md#crhs-侧). */
export function privilegeRoutes(options: PrivilegeRoutesOptions) {
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		throw err;
	});

	/** What to paste into a node's privileged.toml as the crhs trust entry. */
	app.get("/privilege/crhs-key", (c) => {
		const key = options.authorizationKey;
		if (!key) return c.json({ error: "crhs has no authorization signing key" }, 503);
		return c.json({ key: { authorizedKey: key.authorizedKey, fingerprint: key.fingerprint } });
	});

	/** Revokes an authorization and pushes the revocation to the connected nodes (admin only for now). */
	app.post("/authorizations/:id/revoke", requireAdmin, async (c) => {
		if (!options.cluster) return c.json({ error: "the cluster is not running" }, 503);
		const id = c.req.param("id");
		const result = await options.cluster.revokeAuthorization(id, userActor(c.get("user")));
		return c.json({ authorization: { id: result.id, revokedAt: result.revokedAt } });
	});

	return app;
}

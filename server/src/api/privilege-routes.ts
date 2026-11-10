import { Hono } from "hono";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import type { AppEnv } from "./context.ts";

export interface PrivilegeRoutesOptions {
	/** crhs's authorization signing key; without it there is nothing to export. */
	authorizationKey?: AuthorizationSigningKey;
}

/** Expects requireUser to have run. crhs's own signing key (doc/design/privilege.md "Server-side authorization"). */
export function privilegeRoutes(options: PrivilegeRoutesOptions) {
	const app = new Hono<AppEnv>();

	/** What to paste into a node's privileged.toml as the crhs trust entry. */
	app.get("/privilege/crhs-key", (c) => {
		const key = options.authorizationKey;
		if (!key) return c.json({ error: "crhs has no authorization signing key" }, 503);
		return c.json({ key: { authorizedKey: key.authorizedKey, fingerprint: key.fingerprint } });
	});

	return app;
}

import type { SigningKey } from "@crh/api";
import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import { signingKeyTrust } from "../cluster/trust.ts";
import type { AuthorizationSigningKey, AuthorizationSigningKeyStore } from "../privilege/key.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError, optionalString, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

export interface PrivilegeRoutesOptions {
	db: Db;
	/** The live key set; without it the key routes report that none is configured. */
	signingKeys?: AuthorizationSigningKeyStore;
}

function keyView(key: AuthorizationSigningKey, trustedBy: SigningKey["trustedBy"]): SigningKey {
	return {
		id: key.id,
		publicKey: key.authorizedKey,
		fingerprint: key.fingerprint,
		name: key.name,
		createdAt: key.createdAt,
		trustedBy,
	};
}

/**
 * crhs's authorization signing keys (doc/design/privilege.md "Authorization signing key"). The list and the
 * authorized_keys line only need the key set; adding and deleting are administrator-only and use the
 * WebUI session, never an API token. Expects requireUser to have run.
 */
export function privilegeRoutes(options: PrivilegeRoutesOptions) {
	const app = new Hono<AppEnv>();
	const keys = options.signingKeys;

	/** What to paste into a node's privileged.toml as the crhs trust entry: the newest key and all of them. */
	app.get("/privilege/crhs-key", (c) => {
		const newest = keys?.newest;
		if (!keys || !newest) return c.json({ error: "crhs has no authorization signing key" }, 503);
		return c.json({
			key: { authorizedKey: newest.authorizedKey, fingerprint: newest.fingerprint },
			keys: keys.keys.map((key) => ({ authorizedKey: key.authorizedKey, fingerprint: key.fingerprint })),
		});
	});

	/** Every key, newest first, with the nodes whose cached trust report trusts it. */
	app.get("/privilege/signing-keys", requireAdmin, async (c) => {
		if (!keys) return jsonError(c, 503, "signing keys are not configured");
		const trust = await signingKeyTrust(options.db, keys.fingerprints);
		return c.json({
			keys: keys.keys.map((key) => keyView(key, trust.get(key.fingerprint) ?? [])),
		});
	});

	/** Adds a key; it becomes the newest, so the next task on each node prefers it once the node trusts it. */
	app.post("/privilege/signing-keys", requireAdmin, async (c) => {
		if (!keys) return jsonError(c, 503, "signing keys are not configured");
		const body = (await readJsonObject(c)) ?? {};
		const key = await keys.add(optionalString(body, "name"));
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "signing_key.added",
			target: { type: "signing_key", id: key.id },
			detail: { fingerprint: key.fingerprint, name: key.name },
		});
		return c.json({ key: keyView(key, []) }, 201);
	});

	/**
	 * Deletes a key. While a node's cached report still trusts it, `?force=true` is required: the nodes
	 * must remove the entry themselves, or they keep trusting a key crhs no longer holds.
	 */
	app.delete("/privilege/signing-keys/:id", requireAdmin, async (c) => {
		if (!keys) return jsonError(c, 503, "signing keys are not configured");
		const key = keys.get(c.req.param("id"));
		if (!key) return jsonError(c, 404, "no such signing key");
		const trustedBy = (await signingKeyTrust(options.db, [key.fingerprint])).get(key.fingerprint) ?? [];
		const body = await readJsonObject(c);
		const force = body?.force === true || c.req.query("force") === "true";
		if (trustedBy.length > 0 && !force) {
			return c.json(
				{
					error: `${trustedBy.length} node(s) still trust this key; remove the entry there and reload, or pass force=true`,
					nodes: trustedBy,
				},
				409,
			);
		}
		await keys.delete(key.id);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "signing_key.deleted",
			target: { type: "signing_key", id: key.id },
			detail: { fingerprint: key.fingerprint, name: key.name, force },
		});
		return c.json({ ok: true });
	});

	return app;
}

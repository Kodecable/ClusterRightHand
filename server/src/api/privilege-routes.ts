import type { SigningKey } from "@crh/api";
import {
	CrhsKeyResponseSchema,
	ErrorResponseSchema,
	IdParamSchema,
	OkResponseSchema,
	SigningKeyCreateInputSchema,
	SigningKeyCreateResponseSchema,
	SigningKeyDeleteBodySchema,
	SigningKeyDeleteConflictSchema,
	SigningKeyDeleteQuerySchema,
	SigningKeyListResponseSchema,
} from "@crh/api/schemas";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import { signingKeyTrust } from "../cluster/trust.ts";
import type { AuthorizationSigningKey, AuthorizationSigningKeyStore } from "../privilege/key.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError } from "../util/errors.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Privilege"];

const unavailable = () => new HTTPException(503, { message: "signing keys are not configured" });

const crhsKeyRoute = defineRoute({
	method: "get",
	path: "/privilege/crhs-key",
	tags: TAGS,
	summary: "Read crhs's newest authorization signing key and every key, for a node's trust entry",
	agent: "deny",
	responses: {
		200: { description: "The newest key and every key", ...json(CrhsKeyResponseSchema) },
		503: { description: "crhs has no authorization signing key", ...json(ErrorResponseSchema) },
	},
});

const listKeysRoute = defineRoute({
	method: "get",
	path: "/privilege/signing-keys",
	tags: TAGS,
	summary: "List crhs's authorization signing keys, newest first, with the nodes that trust each (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	responses: {
		200: { description: "The keys", ...json(SigningKeyListResponseSchema) },
		503: { description: "Signing keys are not configured", ...json(ErrorResponseSchema) },
	},
});

const addKeyRoute = defineRoute({
	method: "post",
	path: "/privilege/signing-keys",
	tags: TAGS,
	summary: "Add an authorization signing key; it becomes the newest (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { body: { required: false, ...json(SigningKeyCreateInputSchema) } },
	responses: {
		201: { description: "The new key", ...json(SigningKeyCreateResponseSchema) },
		503: { description: "Signing keys are not configured", ...json(ErrorResponseSchema) },
	},
});

const deleteKeyRoute = defineRoute({
	method: "delete",
	path: "/privilege/signing-keys/{id}",
	tags: TAGS,
	summary: "Delete an authorization signing key; nodes that still trust it need force (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: {
		params: IdParamSchema,
		query: SigningKeyDeleteQuerySchema,
		body: { required: false, ...json(SigningKeyDeleteBodySchema) },
	},
	responses: {
		200: { description: "Deleted", ...json(OkResponseSchema) },
		409: {
			description: "Nodes still trust the key; pass force=true to delete it anyway",
			...json(SigningKeyDeleteConflictSchema),
		},
		503: { description: "Signing keys are not configured", ...json(ErrorResponseSchema) },
	},
});

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
	const app = apiRouter();
	const keys = options.signingKeys;

	/** What to paste into a node's privileged.toml as the crhs trust entry: the newest key and all of them. */
	app.openapi(crhsKeyRoute, (c) => {
		const newest = keys?.newest;
		if (!keys || !newest) throw new HTTPException(503, { message: "crhs has no authorization signing key" });
		return c.json(
			{
				key: { authorizedKey: newest.authorizedKey, fingerprint: newest.fingerprint },
				keys: keys.keys.map((key) => ({ authorizedKey: key.authorizedKey, fingerprint: key.fingerprint })),
			},
			200,
		);
	});

	/** Every key, newest first, with the nodes whose cached trust report trusts it. */
	app.openapi(listKeysRoute, async (c) => {
		if (!keys) throw unavailable();
		const trust = await signingKeyTrust(options.db, keys.fingerprints);
		return c.json(
			{
				keys: keys.keys.map((key) => keyView(key, trust.get(key.fingerprint) ?? [])),
			},
			200,
		);
	});

	/** Adds a key; it becomes the newest, so the next task on each node prefers it once the node trusts it. */
	app.openapi(addKeyRoute, async (c) => {
		if (!keys) throw unavailable();
		const key = await keys.add();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "signing_key.added",
			target: { type: "signing_key", id: key.id },
			detail: { fingerprint: key.fingerprint },
		});
		return c.json({ key: keyView(key, []) }, 201);
	});

	/**
	 * Deletes a key. While a node's cached report still trusts it, `?force=true` is required: the nodes
	 * must remove the entry themselves, or they keep trusting a key crhs no longer holds.
	 */
	app.openapi(deleteKeyRoute, async (c) => {
		if (!keys) throw unavailable();
		const { id } = c.req.valid("param");
		const key = keys.get(id);
		if (!key) throw new NotFoundError("no such signing key");
		const trustedBy = (await signingKeyTrust(options.db, [key.fingerprint])).get(key.fingerprint) ?? [];
		const body = c.req.valid("json");
		const force = body.force === true || c.req.valid("query").force === "true";
		if (trustedBy.length > 0 && !force) {
			throw new HTTPException(409, {
				res: c.json(
					{
						error: `${trustedBy.length} node(s) still trust this key; remove the entry there and reload, or pass force=true`,
						nodes: trustedBy,
					},
					409,
				),
			});
		}
		await keys.delete(key.id);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "signing_key.deleted",
			target: { type: "signing_key", id: key.id },
			detail: { fingerprint: key.fingerprint, force },
		});
		return c.json({ ok: true as const }, 200);
	});

	return app;
}

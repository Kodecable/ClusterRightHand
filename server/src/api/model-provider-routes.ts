import { Hono } from "hono";
import {
	builtinProviderIds,
	deleteModelProvider,
	listModelProviders,
	type ModelConfig,
	saveModelProvider,
} from "../agent/models.ts";
import { userActor } from "../audit/audit.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

export interface ModelProviderRoutesOptions {
	models: ModelConfig;
	masterKey: MasterKey;
}

/**
 * The models sessions may choose and the model providers behind them (administrators only);
 * doc/agent-runtime.md. Expects requireUser.
 */
export function modelProviderRoutes(db: Db, options: ModelProviderRoutesOptions) {
	const { models } = options;
	const app = new Hono<AppEnv>();

	app.get("/models", (c) => c.json({ models: models.available() }));

	app.get("/model-providers", requireAdmin, async (c) => {
		return c.json({ providers: await listModelProviders(db), builtin: builtinProviderIds() });
	});

	app.put("/model-providers/:providerId", requireAdmin, async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const has = (key: string) => Object.hasOwn(body, key);
		const provider = await saveModelProvider(db, options.masterKey, {
			providerId: c.req.param("providerId"),
			kind: body.kind as "builtin" | "custom",
			...(has("name") ? { name: body.name } : {}),
			...(has("baseUrl") ? { baseUrl: body.baseUrl } : {}),
			...(has("apiKey") ? { apiKey: body.apiKey } : {}),
			...(has("models") ? { models: body.models } : {}),
			...(has("headers") ? { headers: body.headers } : {}),
			...(has("sessionId") ? { sessionId: body.sessionId } : {}),
			...(has("enabled") ? { enabled: body.enabled } : {}),
		});
		await models.reload();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "model_provider.saved",
			target: { type: "model_provider", id: provider.providerId },
			detail: {
				kind: provider.kind,
				base_url: provider.baseUrl,
				api_key_set: provider.hasApiKey,
				enabled: provider.enabled,
			},
		});
		return c.json({ provider });
	});

	app.delete("/model-providers/:providerId", requireAdmin, async (c) => {
		await deleteModelProvider(db, c.req.param("providerId"));
		await models.reload();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "model_provider.deleted",
			target: { type: "model_provider", id: c.req.param("providerId") },
		});
		return c.json({ ok: true });
	});

	return app;
}

import {
	ModelProviderIdParamSchema,
	ModelProviderInputSchema,
	ModelProviderListResponseSchema,
	ModelProviderResponseSchema,
	ModelsResponseSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
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
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Models"];

const listModelsRoute = defineRoute({
	method: "get",
	path: "/models",
	tags: TAGS,
	summary: "List the models a new session may choose",
	agent: "allow",
	responses: { 200: { description: "The available models", ...json(ModelsResponseSchema) } },
});

const listProvidersRoute = defineRoute({
	method: "get",
	path: "/model-providers",
	tags: TAGS,
	summary: "List the configured model providers; their API keys are never returned (administrators)",
	agent: "allow",
	middleware: [requireAdmin],
	responses: { 200: { description: "The providers and the built-in ids", ...json(ModelProviderListResponseSchema) } },
});

const saveProviderRoute = defineRoute({
	method: "put",
	path: "/model-providers/{providerId}",
	tags: TAGS,
	summary: "Create or replace a model provider and its API key (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ModelProviderIdParamSchema, body: { required: true, ...json(ModelProviderInputSchema) } },
	responses: { 200: { description: "The saved provider", ...json(ModelProviderResponseSchema) } },
});

const deleteProviderRoute = defineRoute({
	method: "delete",
	path: "/model-providers/{providerId}",
	tags: TAGS,
	summary: "Delete a model provider, its API key and its models (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ModelProviderIdParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

export interface ModelProviderRoutesOptions {
	models: ModelConfig;
	masterKey: MasterKey;
}

/**
 * The models sessions may choose and the model providers behind them (administrators only);
 * doc/design/agent-runtime.md. Expects requireUser.
 */
export function modelProviderRoutes(db: Db, options: ModelProviderRoutesOptions) {
	const { models } = options;
	const app = apiRouter();

	app.openapi(listModelsRoute, (c) => c.json({ models: models.available() }, 200));

	app.openapi(listProvidersRoute, async (c) => {
		return c.json({ providers: await listModelProviders(db), builtin: builtinProviderIds() }, 200);
	});

	app.openapi(saveProviderRoute, async (c) => {
		const { providerId } = c.req.valid("param");
		const body = c.req.valid("json");
		const provider = await saveModelProvider(db, options.masterKey, { providerId, ...body });
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
		return c.json({ provider }, 200);
	});

	app.openapi(deleteProviderRoute, async (c) => {
		const { providerId } = c.req.valid("param");
		await deleteModelProvider(db, providerId);
		await models.reload();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "model_provider.deleted",
			target: { type: "model_provider", id: providerId },
		});
		return c.json({ ok: true as const }, 200);
	});

	return app;
}

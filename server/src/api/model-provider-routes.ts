import {
	ErrorResponseSchema,
	ModelDiscoveryInputSchema,
	ModelDiscoveryResponseSchema,
	ModelProviderIdParamSchema,
	ModelProviderInputSchema,
	ModelProviderListResponseSchema,
	ModelProviderResponseSchema,
	ModelsResponseSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import type { Selectable } from "kysely";
import { parseJson } from "../agent/model-providers.ts";
import type { CustomModel, SessionIdConfig } from "../agent/model-types.ts";
import {
	builtinProviderIds,
	deleteModelProvider,
	listModelProviders,
	type ModelCatalogue,
	type ModelConfig,
	type ModelRef,
	modelProviderApiKey,
	saveModelProvider,
} from "../agent/models.ts";
import { userActor } from "../audit/audit.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import type { ModelProvidersTable } from "../storage/schema.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
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

const discoverProviderModelsRoute = defineRoute({
	method: "get",
	path: "/model-providers/{providerId}/discover",
	tags: TAGS,
	summary: "List the models a custom provider offers but does not configure yet (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ModelProviderIdParamSchema },
	responses: {
		200: { description: "The unconfigured model ids the provider lists", ...json(ModelDiscoveryResponseSchema) },
		502: { description: "The provider could not be listed", ...json(ErrorResponseSchema) },
	},
});

const addDiscoveredModelsRoute = defineRoute({
	method: "post",
	path: "/model-providers/{providerId}/discover",
	tags: TAGS,
	summary: "Add listed models to a custom provider, filled from the catalogue (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ModelProviderIdParamSchema, body: { required: true, ...json(ModelDiscoveryInputSchema) } },
	responses: { 200: { description: "The saved provider", ...json(ModelProviderResponseSchema) } },
});

export interface ModelProviderRoutesOptions {
	models: ModelConfig;
	masterKey: MasterKey;
	/** The models.dev catalogue cache and the provider `/models` listing (doc/design/agent-runtime.md "Custom providers"). */
	catalogue: ModelCatalogue;
	/** The session model preset's model; new sessions fall back to it after a user default. */
	sessionModel?: () => ModelRef | null;
}

/** The stored row of a custom provider the discovery routes work on. */
type CustomProviderRow = Selectable<ModelProvidersTable> & { kind: "custom"; base_url: string };

async function customProviderRow(db: Db, providerId: string): Promise<CustomProviderRow> {
	const row = await db
		.selectFrom("model_providers")
		.selectAll()
		.where("provider_id", "=", providerId)
		.executeTakeFirst();
	if (!row) throw new NotFoundError("no such model provider");
	if (row.kind !== "custom") throw new UserError("only a custom provider lists its own models");
	if (row.base_url === null) throw new UserError("the provider has no base URL to list models from");
	return row as CustomProviderRow;
}

/**
 * The models sessions may choose and the model providers behind them (administrators only);
 * doc/design/agent-runtime.md. Expects requireUser.
 */
export function modelProviderRoutes(db: Db, options: ModelProviderRoutesOptions) {
	const { models, masterKey, catalogue } = options;
	const app = apiRouter();

	app.openapi(listModelsRoute, (c) =>
		c.json({ models: models.available(), sessionModel: options.sessionModel?.() ?? null }, 200),
	);

	app.openapi(listProvidersRoute, async (c) => {
		return c.json({ providers: await listModelProviders(db), builtin: builtinProviderIds() }, 200);
	});

	app.openapi(saveProviderRoute, async (c) => {
		const { providerId } = c.req.valid("param");
		const body = c.req.valid("json");
		const provider = await saveModelProvider(db, masterKey, { providerId, ...body });
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

	app.openapi(discoverProviderModelsRoute, async (c) => {
		const { providerId } = c.req.valid("param");
		const row = await customProviderRow(db, providerId);
		// The stored key never reaches the browser: crhs makes the request and returns only the ids.
		const apiKey = await modelProviderApiKey(db, masterKey, row.secret_id);
		const headers = parseJson<Record<string, string>>(row.headers) ?? undefined;
		const ids = await catalogue.discover(row.base_url, apiKey, headers);
		const configured = new Set((parseJson<CustomModel[]>(row.models) ?? []).map((model) => model.id));
		return c.json({ models: ids.filter((id) => !configured.has(id)) }, 200);
	});

	app.openapi(addDiscoveredModelsRoute, async (c) => {
		const { providerId } = c.req.valid("param");
		const body = c.req.valid("json");
		const row = await customProviderRow(db, providerId);
		const existing = parseJson<CustomModel[]>(row.models) ?? [];
		const configured = new Set(existing.map((model) => model.id));
		const ids: string[] = [];
		const seen = new Set<string>();
		for (const raw of body.ids) {
			const id = raw.trim();
			if (id === "") throw new UserError("model ids must not be empty");
			if (seen.has(id)) throw new UserError(`model ${id} is listed twice`);
			if (configured.has(id)) throw new UserError(`model ${id} is already configured`);
			seen.add(id);
			ids.push(id);
		}
		const added = await catalogue.fill(ids, row.base_url);
		// The same persistence path as the provider dialog: the stored key and headers stay untouched.
		const provider = await saveModelProvider(db, masterKey, {
			kind: "custom",
			providerId,
			name: row.name,
			baseUrl: row.base_url,
			models: [...existing, ...added],
			headers: parseJson<Record<string, string>>(row.headers),
			sessionId: parseJson<SessionIdConfig>(row.session_id),
			enabled: row.enabled === 1,
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
				added_models: ids,
			},
		});
		return c.json({ provider }, 200);
	});

	return app;
}

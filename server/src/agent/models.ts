import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Selectable } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import { secretAad } from "../keys/export.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import type { ModelProvidersTable } from "../storage/schema.ts";
import { defaultOrgId, NotFoundError, UserError } from "../users/service.ts";
import { newId } from "../util/id.ts";

/** What a session runs on. */
export interface ModelRef {
	provider: string;
	modelId: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "max";
}

/** A model offered by an OpenAI-compatible endpoint. */
export interface CompatibleModel {
	id: string;
	name?: string;
	contextWindow: number;
	maxTokens: number;
	reasoning?: boolean;
}

export interface ModelProviderView {
	id: string;
	providerId: string;
	kind: ModelProvidersTable["kind"];
	builtin: string | null;
	name: string;
	baseUrl: string | null;
	hasApiKey: boolean;
	models: CompatibleModel[] | null;
	enabled: boolean;
}

const SECRET_KIND = "model_api_key";
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** pi-ai's built-in providers, by id. */
export function builtinProviderIds(): string[] {
	return builtinProviders()
		.map((p) => p.id)
		.sort();
}

function toView(row: Selectable<ModelProvidersTable>): ModelProviderView {
	return {
		id: row.id,
		providerId: row.provider_id,
		kind: row.kind,
		builtin: row.builtin,
		name: row.name,
		baseUrl: row.base_url,
		hasApiKey: row.secret_id !== null,
		models: row.models ? (JSON.parse(row.models) as CompatibleModel[]) : null,
		enabled: row.enabled === 1,
	};
}

export async function listModelProviders(db: Db): Promise<ModelProviderView[]> {
	return (await db.selectFrom("model_providers").selectAll().orderBy("provider_id").execute()).map(toView);
}

export interface ModelProviderInput {
	kind: ModelProvidersTable["kind"];
	/** builtin: pi-ai's provider id (also the provider id references use); openai-compatible: a new id. */
	providerId: string;
	name?: string;
	baseUrl?: string | null;
	/** Omitted: unchanged on update; null: remove. */
	apiKey?: string | null;
	models?: CompatibleModel[];
	enabled?: boolean;
}

function validate(input: ModelProviderInput): void {
	if (!PROVIDER_ID.test(input.providerId)) throw new UserError("provider id must be lowercase letters, digits and -");
	if (input.kind === "builtin") {
		if (!builtinProviderIds().includes(input.providerId))
			throw new UserError(`unknown built-in provider ${input.providerId}`);
	} else if (input.kind === "openai-compatible") {
		if (!input.baseUrl || !/^https?:\/\//.test(input.baseUrl)) throw new UserError("an http(s) base URL is required");
		const models = input.models ?? [];
		if (models.length === 0) throw new UserError("list at least one model");
		for (const m of models) {
			if (typeof m.id !== "string" || !m.id) throw new UserError("every model needs an id");
			if (!Number.isInteger(m.contextWindow) || m.contextWindow < 1024) throw new UserError(`${m.id}: contextWindow`);
			if (!Number.isInteger(m.maxTokens) || m.maxTokens < 1) throw new UserError(`${m.id}: maxTokens`);
		}
	} else {
		throw new UserError("kind must be builtin or openai-compatible");
	}
	if (input.baseUrl && !/^https?:\/\//.test(input.baseUrl)) throw new UserError("base URL must be http(s)");
}

/** Creates or replaces the provider with this provider id (administrators only; checked by the caller). */
export async function saveModelProvider(
	db: Db,
	masterKey: MasterKey,
	input: ModelProviderInput,
): Promise<ModelProviderView> {
	validate(input);
	const now = new Date().toISOString();
	const orgId = await defaultOrgId(db);
	await db.transaction().execute(async (trx) => {
		const existing = await trx
			.selectFrom("model_providers")
			.selectAll()
			.where("provider_id", "=", input.providerId)
			.executeTakeFirst();
		let secretId = existing?.secret_id ?? null;
		if (input.apiKey === null && secretId) {
			await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = null;
		} else if (typeof input.apiKey === "string" && input.apiKey) {
			if (secretId) await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = newId();
			await trx
				.insertInto("secrets")
				.values({
					id: secretId,
					org_id: orgId,
					kind: SECRET_KIND,
					ciphertext: masterKey.encrypt(Buffer.from(input.apiKey), secretAad(secretId, SECRET_KIND)),
					created_at: now,
				})
				.execute();
		}
		const values = {
			kind: input.kind,
			builtin: input.kind === "builtin" ? input.providerId : null,
			name: input.name?.trim() || existing?.name || input.providerId,
			base_url: input.baseUrl ?? null,
			secret_id: secretId,
			models: input.kind === "openai-compatible" ? JSON.stringify(input.models) : null,
			enabled: input.enabled === false ? 0 : 1,
			updated_at: now,
		};
		if (existing) {
			await trx.updateTable("model_providers").set(values).where("id", "=", existing.id).execute();
		} else {
			await trx
				.insertInto("model_providers")
				.values({ id: newId(), org_id: orgId, provider_id: input.providerId, created_at: now, ...values })
				.execute();
		}
	});
	return (await listModelProviders(db)).find((p) => p.providerId === input.providerId) as ModelProviderView;
}

export async function deleteModelProvider(db: Db, providerId: string): Promise<void> {
	const row = await db
		.selectFrom("model_providers")
		.selectAll()
		.where("provider_id", "=", providerId)
		.executeTakeFirst();
	if (!row) throw new NotFoundError("no such model provider");
	await db.transaction().execute(async (trx) => {
		await trx.deleteFrom("model_providers").where("id", "=", row.id).execute();
		if (row.secret_id) await trx.deleteFrom("secrets").where("id", "=", row.secret_id).execute();
	});
}

/** Wraps a provider's api-key auth: the key (and base URL override) come from crhs, never from the environment. */
function withKey(provider: Provider, key: string | undefined, baseUrl: string | null): Provider {
	return {
		...provider,
		auth: {
			apiKey: {
				name: `${provider.name} API key`,
				resolve: async () =>
					key ? { auth: { apiKey: key, ...(baseUrl ? { baseUrl } : {}) }, source: "crhs" } : undefined,
			},
		},
	} as Provider;
}

function compatibleProvider(row: Selectable<ModelProvidersTable>): Provider {
	const baseUrl = row.base_url as string;
	const models = (JSON.parse(row.models ?? "[]") as CompatibleModel[]).map((m) => ({
		id: m.id,
		name: m.name ?? m.id,
		api: "openai-completions" as const,
		provider: row.provider_id,
		baseUrl,
		reasoning: m.reasoning === true,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		type: "chat" as const,
	}));
	return createProvider({
		id: row.provider_id,
		name: row.name,
		baseUrl,
		auth: { apiKey: { name: `${row.name} API key`, resolve: async () => undefined } },
		models: models as never,
		api: openAICompletionsApi(),
	});
}

/**
 * The model registry for the agent runtime, from the configured providers. Rebuilt when an administrator
 * changes the configuration (`reload`).
 */
export class ModelConfig {
	readonly #db: Db;
	readonly #masterKey: MasterKey;
	readonly models: MutableModels;
	/** Tests: providers added in code (e.g. pi-ai's faux provider), kept across reloads. */
	readonly #extra: Provider[] = [];

	constructor(db: Db, masterKey: MasterKey) {
		this.#db = db;
		this.#masterKey = masterKey;
		this.models = createModels();
	}

	addProvider(provider: Provider): void {
		this.#extra.push(provider);
		this.models.setProvider(provider);
	}

	async reload(): Promise<void> {
		const rows = await this.#db.selectFrom("model_providers").selectAll().where("enabled", "=", 1).execute();
		const builtins = new Map(builtinProviders().map((p) => [p.id, p]));
		this.models.clearProviders();
		for (const p of this.#extra) this.models.setProvider(p);
		for (const row of rows) {
			let key: string | undefined;
			if (row.secret_id) {
				const secret = await this.#db
					.selectFrom("secrets")
					.selectAll()
					.where("id", "=", row.secret_id)
					.executeTakeFirst();
				if (secret)
					key = this.#masterKey.decrypt(secret.ciphertext, secretAad(secret.id, secret.kind)).toString("utf8");
			}
			if (row.kind === "builtin") {
				const base = builtins.get(row.builtin ?? "");
				if (base) this.models.setProvider(withKey(base, key, row.base_url));
			} else {
				this.models.setProvider(withKey(compatibleProvider(row), key, null));
			}
		}
	}

	/** Models sessions may pick: those of enabled providers. */
	available(): { provider: string; modelId: string; name: string; contextWindow: number }[] {
		return this.models.getModels().map((m) => ({
			provider: m.provider,
			modelId: m.id,
			name: m.name,
			contextWindow: m.contextWindow,
		}));
	}

	assertAvailable(ref: ModelRef): void {
		if (!this.models.getModel(ref.provider, ref.modelId)) {
			throw new UserError(`model ${ref.provider}/${ref.modelId} is not configured`);
		}
	}
}

/** Who may configure models: administrators (doc/access-control.md#用户类型). */
export function requireAdmin(user: SessionUser): void {
	if (user.kind !== "admin") throw new UserError("administrators only");
}

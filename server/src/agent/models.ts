import type { Api, Model, ModelThinkingLevel, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
	clampThinkingLevel,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type MutableModels,
	type Provider,
} from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CompatSchemasByApi } from "@earendil-works/pi-ai/providers/compat-schema";
import type { Selectable } from "kysely";
import { Value } from "typebox/value";
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
	thinkingLevel?: ModelThinkingLevel;
}

/** pi-ai's thinking levels, from "off" to "max" (doc/agent-runtime.md#思考档位). */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Whether an explicit display name hides a level; an empty string hides it. */
export function levelIsHidden(labels: ThinkingLevelLabels | undefined, level: ModelThinkingLevel): boolean {
	return labels !== undefined && Object.hasOwn(labels, level) && labels[level] === "";
}

/** The display name of a level: its explicit label, else the level id itself. */
export function levelDisplayName(labels: ThinkingLevelLabels | undefined, level: ModelThinkingLevel): string {
	const label = labels?.[level];
	return label === undefined ? level : label;
}

/** The level a ref runs at: an absent level is `off` (doc/agent-runtime.md#思考档位). */
export function thinkingLevelOf(ref: ModelRef): ModelThinkingLevel {
	return ref.thinkingLevel ?? "off";
}

/** The API shape of a ref: the effective level is always present, `off` when none was stored. */
export function modelRefView(ref: ModelRef): ModelRef & { thinkingLevel: ModelThinkingLevel } {
	return { provider: ref.provider, modelId: ref.modelId, thinkingLevel: thinkingLevelOf(ref) };
}

/** Parses `{ provider, modelId, thinkingLevel? }` from user input; throws UserError. */
export function parseModelRef(raw: unknown): ModelRef {
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o.provider !== "string" || typeof o.modelId !== "string") {
		throw new UserError("model must be { provider, modelId }");
	}
	if (o.thinkingLevel !== undefined && !THINKING_LEVELS.includes(o.thinkingLevel as ModelThinkingLevel)) {
		throw new UserError(`thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
	}
	return {
		provider: o.provider,
		modelId: o.modelId,
		...(o.thinkingLevel ? { thinkingLevel: o.thinkingLevel as ModelThinkingLevel } : {}),
	};
}

/** The protocol a custom model speaks. */
export type CustomApi = "openai-completions" | "openai-responses";

/** The pi-ai thinking-parameter formats a Chat Completions model may ask for. */
export const THINKING_FORMATS: readonly NonNullable<OpenAICompletionsCompat["thinkingFormat"]>[] = [
	"openai",
	"openrouter",
	"deepseek",
	"together",
	"baseten",
	"zai",
	"qwen",
	"chat-template",
	"qwen-chat-template",
	"string-thinking",
	"ant-ling",
];

/**
 * Per-level display names of a custom model. A missing key uses the level id itself; an empty
 * string hides the level (doc/agent-runtime.md#思考档位).
 */
export type ThinkingLevelLabels = Partial<Record<ModelThinkingLevel, string>>;

/** pi-ai generates the thinking parameters (`thinkingFormat`, `thinkingLevelMap`). */
export interface ThinkingFormatConfig {
	mode: "standard";
	/** Chat Completions only; Responses always sends `reasoning.effort`. */
	format?: NonNullable<OpenAICompletionsCompat["thinkingFormat"]>;
	/** pi-ai's level map; a null level is unsupported. */
	levels: Partial<Record<ModelThinkingLevel, string | null>>;
	labels?: ThinkingLevelLabels;
}

/** The selected level's object is deep-merged into the request body by the payload hook. */
export interface ThinkingBodyConfig {
	mode: "custom";
	levels: Partial<Record<ModelThinkingLevel, Record<string, unknown>>>;
	labels?: ThinkingLevelLabels;
}

export type ThinkingConfig = ThinkingFormatConfig | ThinkingBodyConfig;

/** One model of a custom provider (doc/agent-runtime.md#自定义提供方). */
export interface CustomModel {
	id: string;
	name?: string;
	api: CustomApi;
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	thinking?: ThinkingConfig;
	/** Advanced pi-ai options, validated against the selected API's compat schema. */
	compat?: Record<string, unknown>;
}

/** Request headers / body paths that carry the crh session id. */
export interface SessionIdConfig {
	headers?: string[];
	body?: string[];
}

export interface ModelProviderView {
	id: string;
	providerId: string;
	kind: ModelProvidersTable["kind"];
	builtin: string | null;
	name: string;
	baseUrl: string | null;
	hasApiKey: boolean;
	models: CustomModel[] | null;
	/** Extra request headers (custom only). */
	headers: Record<string, string> | null;
	/** Fields that carry the crh session id (custom only). */
	sessionId: SessionIdConfig | null;
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

function parseJson<T>(raw: string | null): T | null {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
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
		models: parseJson<CustomModel[]>(row.models),
		headers: parseJson<Record<string, string>>(row.headers),
		sessionId: parseJson<SessionIdConfig>(row.session_id),
		enabled: row.enabled === 1,
	};
}

export async function listModelProviders(db: Db): Promise<ModelProviderView[]> {
	return (await db.selectFrom("model_providers").selectAll().orderBy("provider_id").execute()).map(toView);
}

export interface ModelProviderInput {
	kind: ModelProvidersTable["kind"];
	/** builtin: pi-ai's provider id (also the provider id references use); custom: a new id. */
	providerId: string;
	name?: unknown;
	baseUrl?: unknown;
	/** Omitted: unchanged on update; null: remove. */
	apiKey?: unknown;
	models?: unknown;
	/** Extra request headers; an empty object or null removes them. */
	headers?: unknown;
	/** Fields that carry the crh session id; null removes them. */
	sessionId?: unknown;
	enabled?: unknown;
}

interface ValidProvider {
	kind: ModelProvidersTable["kind"];
	providerId: string;
	name?: string;
	baseUrl: string | null;
	/** undefined: keep the stored key; null: remove it. */
	apiKey: string | null | undefined;
	models: CustomModel[];
	headers: Record<string, string> | null;
	sessionId: SessionIdConfig | null;
	enabled: boolean | undefined;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const BODY_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Headers go on the wire: no CR/LF, and nothing that would break the request
 * (doc/agent-runtime.md#自定义提供方).
 */
function validateHeaders(headers: Record<string, string>): void {
	const names = Object.keys(headers);
	if (names.length > 32) throw new UserError("at most 32 headers");
	for (const name of names) {
		if (!HEADER_NAME.test(name)) throw new UserError(`invalid header name ${JSON.stringify(name)}`);
		const value = headers[name];
		if (typeof value !== "string") throw new UserError(`header ${name} must be a string`);
		if (/[\r\n]/.test(value)) throw new UserError(`header ${name} must not contain line breaks`);
		if (value.length > 2000) throw new UserError(`header ${name} is too long`);
	}
}

function validateSessionId(raw: unknown, prefix: string): SessionIdConfig | null {
	if (raw === null) return null;
	if (!isPlainObject(raw)) throw new UserError(`${prefix}: expected an object or null`);
	for (const key of Object.keys(raw)) {
		if (key !== "headers" && key !== "body") throw new UserError(`${prefix}.${key}: unknown field`);
	}
	const config: SessionIdConfig = {};
	if (raw.headers !== undefined) {
		if (!Array.isArray(raw.headers)) throw new UserError(`${prefix}.headers: expected an array`);
		if (raw.headers.length > 32) throw new UserError(`${prefix}.headers: at most 32 entries`);
		config.headers = raw.headers.map((name, index) => {
			if (typeof name !== "string" || !HEADER_NAME.test(name)) {
				throw new UserError(`${prefix}.headers[${index}]: invalid header name`);
			}
			return name;
		});
	}
	if (raw.body !== undefined) {
		if (!Array.isArray(raw.body)) throw new UserError(`${prefix}.body: expected an array`);
		if (raw.body.length > 32) throw new UserError(`${prefix}.body: at most 32 entries`);
		config.body = raw.body.map((path, index) => {
			if (typeof path !== "string" || path.length === 0 || path.length > 200) {
				throw new UserError(`${prefix}.body[${index}]: expected a dot-separated path`);
			}
			for (const segment of path.split(".")) {
				if (!BODY_PATH_SEGMENT.test(segment)) {
					throw new UserError(
						`${prefix}.body[${index}]: ${JSON.stringify(path)} is not a dot-separated identifier path`,
					);
				}
			}
			return path;
		});
	}
	if ((config.headers?.length ?? 0) === 0 && (config.body?.length ?? 0) === 0) return null;
	return config;
}

/** Validates a level map (`thinking.levels`); standard values are strings/null, custom values objects. */
function validateLevels(raw: unknown, mode: "standard" | "custom", prefix: string): Record<string, unknown> {
	if (!isPlainObject(raw)) throw new UserError(`${prefix}.levels: expected an object`);
	const levels: Record<string, unknown> = {};
	for (const [level, value] of Object.entries(raw)) {
		if (!THINKING_LEVELS.includes(level as ModelThinkingLevel)) {
			throw new UserError(`${prefix}.levels.${level}: unknown thinking level`);
		}
		if (mode === "standard") {
			if (value !== null && (typeof value !== "string" || value.length === 0)) {
				throw new UserError(`${prefix}.levels.${level}: expected a non-empty string or null`);
			}
		} else if (!isPlainObject(value)) {
			throw new UserError(`${prefix}.levels.${level}: expected an object`);
		}
		levels[level] = value;
	}
	return levels;
}

/**
 * Validates `thinking.labels`: display names of custom models. Missing levels use their id, an empty
 * string hides the level, and `off` can be renamed but never hidden.
 */
function validateLabels(raw: unknown, prefix: string): ThinkingLevelLabels | undefined {
	if (raw === undefined) return undefined;
	if (!isPlainObject(raw)) throw new UserError(`${prefix}.labels: expected an object`);
	const labels: ThinkingLevelLabels = {};
	for (const [level, value] of Object.entries(raw)) {
		if (!THINKING_LEVELS.includes(level as ModelThinkingLevel)) {
			throw new UserError(`${prefix}.labels.${level}: unknown thinking level`);
		}
		if (typeof value !== "string") throw new UserError(`${prefix}.labels.${level}: expected a string`);
		const label = value.trim();
		if (level === "off" && label === "") {
			throw new UserError(`${prefix}.labels.off: off cannot be hidden`);
		}
		labels[level as ModelThinkingLevel] = label;
	}
	return Object.keys(labels).length === 0 ? undefined : labels;
}

/** TypeBox errors name the field path, e.g. `models[1].compat.maxTokensField: ...`. */
function validateCompat(raw: unknown, api: CustomApi, prefix: string): Record<string, unknown> {
	if (!isPlainObject(raw)) throw new UserError(`${prefix}: expected an object`);
	const schema = CompatSchemasByApi[api];
	if (Value.Check(schema, raw)) return raw;
	const [error] = Value.Errors(schema, raw);
	if (!error) throw new UserError(`${prefix}: invalid compat options`);
	const path = `${prefix}${error.instancePath.replaceAll("/", ".")}`;
	throw new UserError(`${path}: ${error.message}`);
}

function validateModel(raw: unknown, index: number): CustomModel {
	const prefix = `models[${index}]`;
	if (!isPlainObject(raw)) throw new UserError(`${prefix}: expected an object`);
	const id = raw.id;
	if (typeof id !== "string" || id.trim() === "") throw new UserError(`${prefix}.id: expected a model id`);
	const api = raw.api;
	if (api !== "openai-completions" && api !== "openai-responses") {
		throw new UserError(`${prefix}.api: must be openai-completions or openai-responses`);
	}
	const contextWindow = raw.contextWindow;
	if (!Number.isInteger(contextWindow) || (contextWindow as number) < 1024) {
		throw new UserError(`${prefix}.contextWindow: must be an integer of at least 1024`);
	}
	const maxTokens = raw.maxTokens;
	if (!Number.isInteger(maxTokens) || (maxTokens as number) < 1) {
		throw new UserError(`${prefix}.maxTokens: must be an integer of at least 1`);
	}
	const input = raw.input;
	const inputList = Array.isArray(input) ? (input as unknown[]) : [];
	const validInput =
		inputList.every((value) => value === "text" || value === "image") &&
		inputList.includes("text") &&
		new Set(inputList).size === inputList.length;
	if (!validInput || inputList.length === 0 || inputList.length > 2) {
		throw new UserError(`${prefix}.input: must be ["text"] or ["text", "image"]`);
	}

	let thinking: ThinkingConfig | undefined;
	if (raw.thinking !== undefined) {
		const value = raw.thinking;
		if (!isPlainObject(value)) throw new UserError(`${prefix}.thinking: expected an object`);
		const labels = validateLabels(value.labels, `${prefix}.thinking`);
		if (value.mode === "standard") {
			let format: ThinkingFormatConfig["format"];
			if (value.format !== undefined) {
				// Responses always sends reasoning.effort; a format is a Chat Completions concept.
				if (api !== "openai-completions") {
					throw new UserError(`${prefix}.thinking.format: format is only allowed for openai-completions`);
				}
				if (typeof value.format !== "string" || !THINKING_FORMATS.includes(value.format as never)) {
					throw new UserError(`${prefix}.thinking.format: unknown thinking format`);
				}
				format = value.format as ThinkingFormatConfig["format"];
			}
			thinking = {
				mode: "standard",
				...(format ? { format } : {}),
				levels: validateLevels(value.levels, "standard", `${prefix}.thinking`) as ThinkingFormatConfig["levels"],
				...(labels ? { labels } : {}),
			};
		} else if (value.mode === "custom") {
			if (value.format !== undefined) {
				throw new UserError(`${prefix}.thinking.format: format is only allowed in standard mode`);
			}
			thinking = {
				mode: "custom",
				levels: validateLevels(value.levels, "custom", `${prefix}.thinking`) as ThinkingBodyConfig["levels"],
				...(labels ? { labels } : {}),
			};
		} else {
			throw new UserError(`${prefix}.thinking.mode: must be standard or custom`);
		}
	}

	return {
		id: id.trim(),
		...(typeof raw.name === "string" && raw.name.trim() !== "" ? { name: raw.name.trim() } : {}),
		api,
		contextWindow: contextWindow as number,
		maxTokens: maxTokens as number,
		input: inputList.includes("image") ? ["text", "image"] : ["text"],
		...(thinking ? { thinking } : {}),
		...(raw.compat !== undefined ? { compat: validateCompat(raw.compat, api, `${prefix}.compat`) } : {}),
	};
}

function validate(input: ModelProviderInput): ValidProvider {
	if (!PROVIDER_ID.test(input.providerId)) throw new UserError("provider id must be lowercase letters, digits and -");
	if (input.kind !== "builtin" && input.kind !== "custom") throw new UserError("kind must be builtin or custom");
	if (input.name !== undefined && typeof input.name !== "string") throw new UserError("name must be a string");
	if (input.baseUrl !== undefined && input.baseUrl !== null && typeof input.baseUrl !== "string") {
		throw new UserError("base URL must be a string or null");
	}
	if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== "string") {
		throw new UserError("apiKey must be a string or null");
	}
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
		throw new UserError("enabled must be a boolean");
	}
	let headers: Record<string, string> | null = null;
	if (input.headers !== undefined && input.headers !== null) {
		if (!isPlainObject(input.headers)) throw new UserError("headers must be an object or null");
		for (const [name, value] of Object.entries(input.headers)) {
			if (typeof value !== "string") throw new UserError(`header ${name} must be a string`);
		}
		headers = input.headers as Record<string, string>;
		validateHeaders(headers);
		if (Object.keys(headers).length === 0) headers = null;
	}
	const sessionId = input.sessionId === undefined ? null : validateSessionId(input.sessionId, "sessionId");

	if (input.kind === "builtin") {
		if (!builtinProviderIds().includes(input.providerId)) {
			throw new UserError(`unknown Pi built-in provider ${input.providerId}`);
		}
		if (input.baseUrl !== undefined && input.baseUrl !== null && !/^https?:\/\//.test(input.baseUrl)) {
			throw new UserError("base URL must be http(s)");
		}
		return {
			kind: "builtin",
			providerId: input.providerId,
			...(typeof input.name === "string" ? { name: input.name } : {}),
			baseUrl: (input.baseUrl as string | null | undefined) ?? null,
			apiKey: input.apiKey as string | null | undefined,
			models: [],
			headers,
			sessionId,
			enabled: input.enabled as boolean | undefined,
		};
	}

	const baseUrl = input.baseUrl;
	if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
		throw new UserError("an http(s) base URL is required");
	}
	if (!Array.isArray(input.models)) throw new UserError("models: expected an array");
	if (input.models.length === 0) throw new UserError("list at least one model");
	const models = input.models.map((model, index) => validateModel(model, index));
	const ids = new Set(models.map((model) => model.id));
	if (ids.size !== models.length) throw new UserError("model ids must be unique");
	return {
		kind: "custom",
		providerId: input.providerId,
		...(typeof input.name === "string" ? { name: input.name } : {}),
		baseUrl,
		apiKey: input.apiKey as string | null | undefined,
		models,
		headers,
		sessionId,
		enabled: input.enabled as boolean | undefined,
	};
}

/** Creates or replaces the provider with this provider id (administrators only; checked by the caller). */
export async function saveModelProvider(
	db: Db,
	masterKey: MasterKey,
	input: ModelProviderInput,
): Promise<ModelProviderView> {
	const valid = validate(input);
	const now = new Date().toISOString();
	const orgId = await defaultOrgId(db);
	await db.transaction().execute(async (trx) => {
		const existing = await trx
			.selectFrom("model_providers")
			.selectAll()
			.where("provider_id", "=", valid.providerId)
			.executeTakeFirst();
		let secretId = existing?.secret_id ?? null;
		if (valid.apiKey === null && secretId) {
			await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = null;
		} else if (typeof valid.apiKey === "string" && valid.apiKey) {
			if (secretId) await trx.deleteFrom("secrets").where("id", "=", secretId).execute();
			secretId = newId();
			await trx
				.insertInto("secrets")
				.values({
					id: secretId,
					org_id: orgId,
					kind: SECRET_KIND,
					ciphertext: masterKey.encrypt(Buffer.from(valid.apiKey), secretAad(secretId, SECRET_KIND)),
					created_at: now,
				})
				.execute();
		}
		const headers =
			valid.kind === "custom" && input.headers !== undefined ? valid.headers : (existing?.headers ?? null);
		const sessionId =
			valid.kind === "custom" && input.sessionId !== undefined ? valid.sessionId : (existing?.session_id ?? null);
		const values = {
			kind: valid.kind,
			builtin: valid.kind === "builtin" ? valid.providerId : null,
			name: valid.name?.trim() || existing?.name || valid.providerId,
			base_url: valid.baseUrl,
			secret_id: secretId,
			models: valid.kind === "custom" ? JSON.stringify(valid.models) : null,
			headers:
				valid.kind === "custom"
					? typeof headers === "string"
						? headers
						: headers && Object.keys(headers).length > 0
							? JSON.stringify(headers)
							: null
					: null,
			session_id:
				valid.kind === "custom"
					? typeof sessionId === "string"
						? sessionId
						: sessionId
							? JSON.stringify(sessionId)
							: null
					: null,
			enabled: valid.enabled === false ? 0 : 1,
			updated_at: now,
		};
		if (existing) {
			await trx.updateTable("model_providers").set(values).where("id", "=", existing.id).execute();
		} else {
			await trx
				.insertInto("model_providers")
				.values({ id: newId(), org_id: orgId, provider_id: valid.providerId, created_at: now, ...values })
				.execute();
		}
	});
	return (await listModelProviders(db)).find((p) => p.providerId === valid.providerId) as ModelProviderView;
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

/** Wraps a built-in provider's api-key auth: the key (and base URL override) come from crhs. */
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

/** Resolves the provider session id of a durable request to the crh session it belongs to. */
export type ProviderSessionResolver = (providerSessionId: string) => string | undefined;

/** The pi-ai model fields a stored custom model maps to. */
function customPiModel(
	providerId: string,
	baseUrl: string,
	headers: Record<string, string> | undefined,
	model: CustomModel,
): Model<Api> {
	const thinking = model.thinking;
	const compat = { ...((model.compat ?? {}) as Record<string, unknown>) };
	let thinkingLevelMap: ThinkingLevelMap | undefined;
	if (thinking?.mode === "standard") {
		if (thinking.format) compat.thinkingFormat = thinking.format;
		// A hidden level maps to null so pi-ai does not offer it; an explicit null (the old
		// "disabled" choice) already means the same. pi-ai offers xhigh/max only when the map has a
		// value for them, so a non-empty display name without a mapped value offers the level and
		// sends its id as-is.
		const map: ThinkingLevelMap = { ...thinking.levels };
		for (const level of THINKING_LEVELS) {
			if (levelIsHidden(thinking.labels, level)) map[level] = null;
			else if ((level === "xhigh" || level === "max") && map[level] === undefined) {
				if (thinking.labels?.[level] !== undefined) map[level] = level;
			}
		}
		thinkingLevelMap = map;
	} else if (thinking?.mode === "custom") {
		// Every level pi-ai could offer, except `off`, is unsupported unless the body map lists it
		// with a visible display name.
		const map: ThinkingLevelMap = {};
		for (const level of THINKING_LEVELS) {
			if (level === "off") continue;
			map[level] = Object.hasOwn(thinking.levels, level) && !levelIsHidden(thinking.labels, level) ? level : null;
		}
		thinkingLevelMap = map;
		if (model.api === "openai-completions") {
			// pi-ai must not add its own thinking parameters: the selected level's object is merged
			// into the payload instead (doc/agent-runtime.md#自定义提供方). Forcing `openai` avoids
			// URL-detected formats such as deepseek that add `thinking`/`enable_thinking` even when
			// `supportsReasoningEffort` is false.
			compat.thinkingFormat = "openai";
			compat.supportsReasoningEffort = false;
			compat.supportsThinkingTokenBudget = false;
			delete compat.thinkingTokenBudgetField;
		}
	}
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: model.api,
		provider: providerId,
		baseUrl,
		reasoning: thinking !== undefined,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: model.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...(headers ? { headers } : {}),
		...(Object.keys(compat).length > 0 ? { compat } : {}),
		type: "chat",
	} as Model<Api>;
}

/** Deep-merges `source` into `target` (objects recursively, everything else replaces). */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	for (const [key, value] of Object.entries(source)) {
		const current = target[key];
		if (isPlainObject(current) && isPlainObject(value)) {
			deepMerge(current, value);
		} else {
			target[key] = structuredClone(value);
		}
	}
	return target;
}

/** Removes the thinking parameters pi-ai adds for body-mode models. */
function stripThinking(payload: Record<string, unknown>, api: CustomApi): void {
	if (api === "openai-completions") {
		for (const key of [
			"reasoning_effort",
			"thinking",
			"enable_thinking",
			"reasoning",
			"chat_template_kwargs",
			"chat_template_args",
			"thinking_token_budget",
			"thinking_budget",
			"thinking_budget_tokens",
		]) {
			delete payload[key];
		}
		return;
	}
	delete payload.reasoning;
	if (Array.isArray(payload.include)) {
		const include = payload.include.filter((entry) => entry !== "reasoning.encrypted_content");
		if (include.length > 0) payload.include = include;
		else delete payload.include;
	}
}

/** Sets a dot-separated path to `value`, creating intermediate objects. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const segments = path.split(".");
	let current = target;
	for (const [index, segment] of segments.entries()) {
		if (index === segments.length - 1) {
			current[segment] = value;
		} else {
			const next = current[segment];
			if (!isPlainObject(next)) current[segment] = {};
			current = current[segment] as Record<string, unknown>;
		}
	}
}

/** The request options the wrapper edits; every field is optional, matching pi-ai's stream options. */
interface RequestOptions {
	sessionId?: string;
	reasoning?: ModelThinkingLevel;
	reasoningEffort?: string;
	headers?: Record<string, string | null>;
	onPayload?: (payload: unknown, model: Model<Api>) => unknown;
}

function customProvider(
	row: Selectable<ModelProvidersTable>,
	key: string | undefined,
	resolveSession: ProviderSessionResolver,
): Provider {
	const baseUrl = row.base_url as string;
	const headers = parseJson<Record<string, string>>(row.headers) ?? undefined;
	const sessionId = parseJson<SessionIdConfig>(row.session_id);
	const models = parseJson<CustomModel[]>(row.models) ?? [];
	const configs = new Map(models.map((model) => [model.id, model]));
	const piModels = models.map((model) => customPiModel(row.provider_id, baseUrl, headers, model));
	const base = createProvider({
		id: row.provider_id,
		name: row.name,
		baseUrl,
		auth: {
			apiKey: {
				// A keyless local endpoint still needs a non-empty credential for the OpenAI SDK;
				// this placeholder is not a secret and is the only value sent without a configured key.
				name: `${row.name} API key`,
				resolve: async () => ({ auth: { apiKey: key ?? "unused" }, source: "crhs" }),
			},
		},
		models: piModels as never,
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
	const sessionHeaders = sessionId?.headers ?? [];
	const sessionBody = sessionId?.body ?? [];

	/** Per-request options: session headers and a payload hook for session fields / body-mode thinking. */
	const adapt = (model: Model<Api>, options: RequestOptions | undefined, simple: boolean): RequestOptions => {
		const session = options?.sessionId ? resolveSession(options.sessionId) : undefined;
		const config = configs.get(model.id);
		const level: ModelThinkingLevel = simple
			? options?.reasoning
				? clampThinkingLevel(model, options.reasoning)
				: "off"
			: ((options?.reasoningEffort as ModelThinkingLevel | undefined) ?? "off");
		const bodyConfig = config?.thinking?.mode === "custom" ? config.thinking : undefined;
		const body = bodyConfig?.levels[level];
		// Body mode always owns the payload's thinking parameters: even a level with no body entry must drop
		// pi-ai's own parameters (doc/agent-runtime.md#自定义提供方).
		const needsPayload = bodyConfig !== undefined || (session !== undefined && sessionBody.length > 0);
		const nextHeaders =
			session !== undefined && sessionHeaders.length > 0
				? { ...options?.headers, ...Object.fromEntries(sessionHeaders.map((name) => [name, session])) }
				: options?.headers;
		if (!needsPayload) return { ...options, headers: nextHeaders };

		const previous = options?.onPayload;
		const onPayload = async (payload: unknown) => {
			const next = payload;
			if (isPlainObject(next)) {
				// Body mode owns the thinking parameters: drop whatever pi-ai added before merging. The
				// compat overrides above stop Chat Completions from adding them; Responses has no compat
				// switch, so its `reasoning`/`include` are removed here.
				if (bodyConfig) stripThinking(next, model.api as CustomApi);
				if (body !== undefined) deepMerge(next, body);
				if (session !== undefined) for (const path of sessionBody) setPath(next, path, session);
			}
			const replaced = previous ? await previous(next, model) : undefined;
			return replaced === undefined ? next : replaced;
		};
		return { ...options, headers: nextHeaders, onPayload };
	};

	const provider = base as Provider;
	return {
		...provider,
		stream: (model, context, options) =>
			provider.stream(model, context, adapt(model as Model<Api>, options, false) as never),
		streamSimple: (model, context, options) =>
			provider.streamSimple(model, context, adapt(model as Model<Api>, options, true) as never),
	} as Provider;
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
	/** Custom models by `provider/modelId`, for their per-level display names (`available`). */
	readonly #customModels = new Map<string, CustomModel>();
	/** Installed by the runtime: provider session id -> crh session id (doc/agent-runtime.md#自定义提供方). */
	#providerSessionId: ProviderSessionResolver = () => undefined;
	#providerSessionFor: (sessionId: string) => string | undefined = () => undefined;

	constructor(db: Db, masterKey: MasterKey) {
		this.#db = db;
		this.#masterKey = masterKey;
		this.models = createModels();
	}

	/** Installs the runtime's provider-session mapping, used for custom providers' session id fields. */
	setSessionResolver(
		resolve: ProviderSessionResolver,
		providerSessionIdFor: (sessionId: string) => string | undefined,
	): void {
		this.#providerSessionId = resolve;
		this.#providerSessionFor = providerSessionIdFor;
	}

	/** The crh session id of a provider session id, or undefined when the mapping is not known (yet). */
	resolveProviderSession(providerSessionId: string | undefined): string | undefined {
		if (!providerSessionId) return undefined;
		return this.#providerSessionId(providerSessionId);
	}

	/** The provider session id of a crh session, for callers outside a durable conversation (Auto Review). */
	providerSessionIdFor(sessionId: string): string | undefined {
		return this.#providerSessionFor(sessionId);
	}

	addProvider(provider: Provider): void {
		this.#extra.push(provider);
		this.models.setProvider(provider);
	}

	async reload(): Promise<void> {
		const rows = await this.#db.selectFrom("model_providers").selectAll().where("enabled", "=", 1).execute();
		const builtins = new Map(builtinProviders().map((p) => [p.id, p]));
		this.models.clearProviders();
		this.#customModels.clear();
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
				for (const model of parseJson<CustomModel[]>(row.models) ?? []) {
					this.#customModels.set(`${row.provider_id}/${model.id}`, model);
				}
				this.models.setProvider(customProvider(row, key, (id) => this.resolveProviderSession(id)));
			}
		}
	}

	/** Models sessions may pick: those of enabled providers, with their levels and input kinds. */
	available(): {
		provider: string;
		providerName: string;
		modelId: string;
		name: string;
		contextWindow: number;
		thinkingLevels: ModelThinkingLevel[];
		/** Custom models only: the display name of every offered level (its id by default). */
		thinkingLabels?: ThinkingLevelLabels;
		input: ("text" | "image")[];
	}[] {
		return this.models.getModels().map((m) => {
			const custom = this.#customModels.get(`${m.provider}/${m.id}`);
			const thinkingLevels = getSupportedThinkingLevels(m);
			return {
				provider: m.provider,
				providerName: this.models.getProvider(m.provider)?.name ?? m.provider,
				modelId: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				thinkingLevels,
				...(custom
					? {
							thinkingLabels: Object.fromEntries(
								thinkingLevels.map((level) => [level, levelDisplayName(custom.thinking?.labels, level)]),
							) as ThinkingLevelLabels,
						}
					: {}),
				input: [...m.input],
			};
		});
	}

	assertAvailable(ref: ModelRef): void {
		if (!this.models.getModel(ref.provider, ref.modelId)) {
			throw new UserError(`model ${ref.provider}/${ref.modelId} is not configured`);
		}
	}

	/**
	 * Resolves a model reference to the level it runs at (doc/agent-runtime.md#思考档位): an explicit level must be
	 * supported by the model, otherwise a model change keeps the previous level, clamped to the nearest supported
	 * one. The returned ref omits `off`, the stored convention; callers use `thinkingLevelOf` for the durable config.
	 */
	resolveRef(ref: ModelRef, previousLevel?: ModelThinkingLevel): ModelRef {
		const model = this.models.getModel(ref.provider, ref.modelId);
		if (!model) throw new UserError(`model ${ref.provider}/${ref.modelId} is not configured`);
		let level: ModelThinkingLevel;
		if (ref.thinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(model);
			if (!supported.includes(ref.thinkingLevel)) {
				throw new UserError(
					`thinking level ${ref.thinkingLevel} is not supported by ${ref.provider}/${ref.modelId}; supported: ${supported.join(", ")}`,
				);
			}
			level = ref.thinkingLevel;
		} else {
			level = clampThinkingLevel(model, previousLevel ?? "off");
		}
		return {
			provider: ref.provider,
			modelId: ref.modelId,
			...(level === "off" ? {} : { thinkingLevel: level }),
		};
	}
}

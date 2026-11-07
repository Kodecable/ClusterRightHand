// Validation of administrator input for model providers (doc/agent-runtime.md#自定义提供方).

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CompatSchemasByApi } from "@earendil-works/pi-ai/providers/compat-schema";
import { Value } from "typebox/value";
import type { ModelProvidersTable } from "../storage/schema.ts";
import { UserError } from "../users/service.ts";
import {
	type CustomApi,
	type CustomModel,
	type SessionIdConfig,
	THINKING_FORMATS,
	THINKING_LEVELS,
	type ThinkingBodyConfig,
	type ThinkingConfig,
	type ThinkingFormatConfig,
	type ThinkingLevelLabels,
} from "./model-types.ts";

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** pi-ai's built-in providers, by id. */
export function builtinProviderIds(): string[] {
	return builtinProviders()
		.map((p) => p.id)
		.sort();
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
/** Names that address an object's prototype chain instead of a field of the request body. */
const UNSAFE_PROPERTY_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `key` is one of the names that must never be written into a JSON object by configuration. */
export function isUnsafePropertyKey(key: string): boolean {
	return UNSAFE_PROPERTY_KEYS.has(key);
}

/**
 * Rejects the unsafe names anywhere in a custom thinking level's request-body JSON, which is merged into
 * the provider's payload: a `__proto__` key would otherwise be assigned into the prototype.
 */
function validateRequestBodyKeys(value: unknown, prefix: string): void {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) validateRequestBodyKeys(entry, `${prefix}[${index}]`);
		return;
	}
	if (!isPlainObject(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		if (isUnsafePropertyKey(key)) {
			throw new UserError(`${prefix}.${key}: a request body cannot contain __proto__, constructor or prototype`);
		}
		validateRequestBodyKeys(entry, `${prefix}.${key}`);
	}
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
				if (isUnsafePropertyKey(segment)) {
					throw new UserError(
						`${prefix}.body[${index}]: ${JSON.stringify(path)} cannot use __proto__, constructor or prototype`,
					);
				}
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
		} else {
			if (!isPlainObject(value)) throw new UserError(`${prefix}.levels.${level}: expected an object`);
			validateRequestBodyKeys(value, `${prefix}.levels.${level}`);
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

export function validate(input: ModelProviderInput): ValidProvider {
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

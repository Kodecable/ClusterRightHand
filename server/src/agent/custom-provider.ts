// pi-ai providers built from stored configuration: built-in providers with a crhs-held key, and custom
// OpenAI-compatible providers with their thinking and session id handling (doc/agent-runtime.md#自定义提供方).

import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { clampThinkingLevel, createProvider, type Provider } from "@earendil-works/pi-ai/models";
import type { Selectable } from "kysely";
import type { ModelProvidersTable } from "../storage/schema.ts";
import { parseJson } from "./model-providers.ts";
import {
	type CustomApi,
	type CustomModel,
	levelIsHidden,
	type SessionIdConfig,
	THINKING_LEVELS,
} from "./model-types.ts";
import { isPlainObject, isUnsafePropertyKey } from "./model-validate.ts";

/** Wraps a built-in provider's api-key auth: the key (and base URL override) come from crhs. */
export function withKey(provider: Provider, key: string | undefined, baseUrl: string | null): Provider {
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

/**
 * Deep-merges `source` into `target` (objects recursively, everything else replaces). Prototype names are
 * skipped, and an existing object is only descended into when it is an own property of `target`.
 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
	for (const [key, value] of Object.entries(source)) {
		if (isUnsafePropertyKey(key)) continue;
		const current = Object.hasOwn(target, key) ? target[key] : undefined;
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

/**
 * Sets a dot-separated path to `value`, creating intermediate objects. A path with a prototype name is
 * ignored, and an intermediate object is only reused when it is an own property of the object above it.
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const segments = path.split(".");
	if (segments.some(isUnsafePropertyKey)) return;
	let current = target;
	for (const [index, segment] of segments.entries()) {
		if (index === segments.length - 1) {
			current[segment] = value;
		} else {
			const next = Object.hasOwn(current, segment) ? current[segment] : undefined;
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

export function customProvider(
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

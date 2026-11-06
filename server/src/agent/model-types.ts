// Model references and the stored shape of custom providers, shared by the model registry, validation and the
// custom provider adapter.

import type { ModelThinkingLevel, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { UserError } from "../users/service.ts";

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

// Model references and the stored shape of custom providers, shared by the model registry, validation and the
// custom provider adapter.

import type {
	CustomApi,
	CustomModel,
	SessionIdConfig,
	ThinkingBodyConfig,
	ThinkingConfig,
	ThinkingFormat,
	ThinkingFormatConfig,
	ThinkingLevelLabels,
} from "@crh/api";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { UserError } from "../users/service.ts";

export type {
	CustomApi,
	CustomModel,
	SessionIdConfig,
	ThinkingBodyConfig,
	ThinkingConfig,
	ThinkingFormatConfig,
	ThinkingLevelLabels,
};

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

/** The pi-ai thinking-parameter formats a Chat Completions model may ask for. */
export const THINKING_FORMATS: readonly ThinkingFormat[] = [
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

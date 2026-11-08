/**
 * Models, model providers and model presets (doc/agent-runtime.md "模型配置",
 * "自定义提供方" and "模型预设").
 */

/** pi-ai's thinking levels (doc/agent-runtime.md "思考档位"). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A model choice; an absent thinking level means `off`. */
export interface ModelRef {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

/** One entry of `GET /api/models`. */
export interface AvailableModel extends ModelRef {
	providerName: string;
	name: string;
	contextWindow: number;
	/** The levels this model supports, `off` included. */
	thinkingLevels: ThinkingLevel[];
	/** Custom models only: the display name of every offered level (its id by default). */
	thinkingLabels?: Partial<Record<ThinkingLevel, string>>;
	input: ("text" | "image")[];
}

/** The protocol a custom model speaks. */
export type CustomApi = "openai-completions" | "openai-responses";

/** The pi-ai thinking-parameter formats a Chat Completions model may ask for. */
export type ThinkingFormat =
	| "openai"
	| "openrouter"
	| "deepseek"
	| "together"
	| "baseten"
	| "zai"
	| "qwen"
	| "chat-template"
	| "qwen-chat-template"
	| "string-thinking"
	| "ant-ling";

/**
 * Per-level display names of a custom model. A missing key uses the level id
 * itself; an empty string hides the level (doc/agent-runtime.md "思考档位").
 */
export type ThinkingLevelLabels = Partial<Record<ThinkingLevel, string>>;

/** pi-ai generates the thinking parameters (`thinkingFormat`, `thinkingLevelMap`). */
export interface ThinkingFormatConfig {
	mode: "standard";
	/** Chat Completions only. */
	format?: ThinkingFormat;
	/** pi-ai's level map; a null level is unsupported. */
	levels: Partial<Record<ThinkingLevel, string | null>>;
	labels?: ThinkingLevelLabels;
}

/** The selected level's object is deep-merged into the request body by the payload hook. */
export interface ThinkingBodyConfig {
	mode: "custom";
	levels: Partial<Record<ThinkingLevel, Record<string, unknown>>>;
	labels?: ThinkingLevelLabels;
}

export type ThinkingConfig = ThinkingFormatConfig | ThinkingBodyConfig;

/** One model of a custom provider (doc/agent-runtime.md "自定义提供方"). */
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

/** Request headers / body paths that carry the crh session id (custom providers). */
export interface SessionIdConfig {
	headers?: string[];
	body?: string[];
}

export interface ModelProviderView {
	id: string;
	providerId: string;
	kind: "builtin" | "custom";
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

/** Body of `PUT /api/model-providers/:providerId`. */
export interface ModelProviderInput {
	kind: "builtin" | "custom";
	name?: string;
	baseUrl?: string | null;
	/** Omitted: keep the current key; null: remove it. */
	apiKey?: string | null;
	models?: CustomModel[];
	/** Extra request headers (custom); null removes them. */
	headers?: Record<string, string> | null;
	/** Session id fields (custom); null removes them. */
	sessionId?: SessionIdConfig | null;
	enabled?: boolean;
}

/** One model preset kind (D116, doc/agent-runtime.md "模型预设"). */
export type ModelPresetKind = "session" | "review" | "title";

export interface ModelPreset {
	kind: ModelPresetKind;
	/** null: the root's own model (review/title) or unset (session). */
	model: ModelRef | null;
	/** null: the default prompt. */
	systemPrompt: string | null;
	/** The prompt used when no custom one is set. */
	defaultPrompt: string;
	/** The fixed protocol text, always appended. */
	protocol: string;
}

/** Body of `PUT /api/model-presets/:kind`; omitted fields stay unchanged, null clears. */
export interface ModelPresetInput {
	model?: ModelRef | null;
	systemPrompt?: string | null;
}

/**
 * Runtime schemas for models, model providers and model presets (`../models.ts`,
 * doc/design/agent-runtime.md "Model configuration", "Custom providers" and "Model presets").
 */
import { z } from "zod";

/** pi-ai's thinking levels (doc/design/agent-runtime.md "Thinking levels"). */
export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** A model choice; an absent thinking level means `off`. */
export const ModelRefSchema = z
	.object({
		provider: z.string(),
		modelId: z.string(),
		thinkingLevel: ThinkingLevelSchema.optional(),
	})
	.meta({ id: "ModelRef" });

/** Per-level display names of a custom model; an empty string hides the level. */
export const ThinkingLevelLabelsSchema = z.partialRecord(ThinkingLevelSchema, z.string());

/** The protocol a custom model speaks. */
export const CustomApiSchema = z.enum(["openai-completions", "openai-responses"]);

/** The pi-ai thinking-parameter formats a Chat Completions model may ask for. */
export const ThinkingFormatSchema = z.enum([
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
]);

/** pi-ai generates the thinking parameters (`thinkingFormat`, `thinkingLevelMap`). */
export const ThinkingFormatConfigSchema = z
	.object({
		mode: z.literal("standard"),
		format: ThinkingFormatSchema.optional().describe("Chat Completions only."),
		levels: z
			.partialRecord(ThinkingLevelSchema, z.string().nullable())
			.describe("pi-ai's level map; a null level is unsupported."),
		labels: ThinkingLevelLabelsSchema.optional(),
	})
	.meta({ id: "ThinkingFormatConfig" });

/** The selected level's object is deep-merged into the request body by the payload hook. */
export const ThinkingBodyConfigSchema = z
	.object({
		mode: z.literal("custom"),
		levels: z.partialRecord(ThinkingLevelSchema, z.record(z.string(), z.unknown())),
		labels: ThinkingLevelLabelsSchema.optional(),
	})
	.meta({ id: "ThinkingBodyConfig" });

export const ThinkingConfigSchema = z
	.discriminatedUnion("mode", [ThinkingFormatConfigSchema, ThinkingBodyConfigSchema])
	.meta({ id: "ThinkingConfig" });

/** One model of a custom provider (doc/design/agent-runtime.md "Custom providers"). */
export const CustomModelSchema = z
	.object({
		id: z.string(),
		name: z.string().optional(),
		api: CustomApiSchema,
		contextWindow: z.number(),
		maxTokens: z.number(),
		input: z.array(z.enum(["text", "image"])),
		thinking: ThinkingConfigSchema.optional(),
		compat: z.record(z.string(), z.unknown()).optional().describe("Advanced pi-ai options for the selected API."),
	})
	.meta({ id: "CustomModel" });

/** Request headers / body paths that carry the crh session id (custom providers). */
export const SessionIdConfigSchema = z
	.object({
		headers: z.array(z.string()).optional(),
		body: z.array(z.string()).optional(),
	})
	.strict()
	.meta({ id: "SessionIdConfig" });

/** One entry of `GET /api/models`. */
export const AvailableModelSchema = z
	.object({
		provider: z.string(),
		providerName: z.string(),
		modelId: z.string(),
		name: z.string(),
		contextWindow: z.number(),
		thinkingLevels: z.array(ThinkingLevelSchema).describe("The levels this model supports, `off` included."),
		thinkingLabels: ThinkingLevelLabelsSchema.optional().describe(
			"Custom models only: the display name of every offered level.",
		),
		input: z.array(z.enum(["text", "image"])),
	})
	.meta({ id: "AvailableModel" });

export const ModelsResponseSchema = z.object({
	models: z.array(AvailableModelSchema),
	sessionModel: ModelRefSchema.nullable().describe(
		"The session model preset's model when one is set; new sessions default to it before the first offered model.",
	),
});

/** A model provider as administrators see it; its API key is never returned. */
export const ModelProviderViewSchema = z
	.object({
		id: z.string(),
		providerId: z.string(),
		kind: z.enum(["builtin", "custom"]),
		builtin: z.string().nullable().describe("The pi-ai built-in provider id; null for a custom provider."),
		name: z.string(),
		baseUrl: z.string().nullable(),
		hasApiKey: z.boolean().describe("Whether a key is stored; the key itself is never returned."),
		models: z.array(CustomModelSchema).nullable(),
		headers: z.record(z.string(), z.string()).nullable().describe("Extra request headers (custom only)."),
		sessionId: SessionIdConfigSchema.nullable(),
		enabled: z.boolean(),
	})
	.meta({ id: "ModelProviderView" });

/** Body of `PUT /api/model-providers/{providerId}`; omitted fields keep their stored value. */
export const ModelProviderInputSchema = z.object({
	kind: z.enum(["builtin", "custom"]),
	name: z.string().optional(),
	baseUrl: z.string().nullable().optional(),
	apiKey: z.string().nullable().optional().describe("Omitted: keep the stored key; null: remove it."),
	models: z.array(CustomModelSchema).optional(),
	headers: z.record(z.string(), z.string()).nullable().optional().describe("Extra request headers; null removes them."),
	sessionId: SessionIdConfigSchema.nullable().optional(),
	enabled: z.boolean().optional(),
});

export const ModelProviderListResponseSchema = z
	.object({
		providers: z.array(ModelProviderViewSchema),
		builtin: z.array(z.string()).describe("The ids of the pi-ai built-in providers."),
	})
	.meta({ id: "ModelProviderListResponse" });

export const ModelProviderResponseSchema = z.object({ provider: ModelProviderViewSchema });

/**
 * The model ids a custom provider lists that are not configured on it yet
 * (doc/design/agent-runtime.md "Custom providers").
 */
export const ModelDiscoveryResponseSchema = z
	.object({
		models: z.array(z.string()).describe("The upstream model ids that the provider does not configure yet."),
	})
	.meta({ id: "ModelDiscoveryResponse" });

/** Body of `POST /api/model-providers/{providerId}/discover`: the listed ids to add. */
export const ModelDiscoveryInputSchema = z.object({
	ids: z.array(z.string()).min(1).describe("Model ids returned by the provider's list; each is added once."),
});

/** One model preset kind (doc/design/agent-runtime.md "Model presets"). */
export const ModelPresetKindSchema = z.enum(["session", "review", "title"]);

export const ModelPresetSchema = z
	.object({
		kind: ModelPresetKindSchema,
		model: ModelRefSchema.nullable().describe("null: the root's own model (review/title) or unset (session)."),
		systemPrompt: z.string().nullable().describe("null: the default prompt."),
		defaultPrompt: z.string().describe("The prompt used when no custom one is set."),
		protocol: z.string().describe("The fixed protocol text, always appended."),
	})
	.meta({ id: "ModelPreset" });

/** Body of `PUT /api/model-presets/{kind}`; omitted fields stay unchanged, null clears. */
export const ModelPresetInputSchema = z.object({
	model: ModelRefSchema.nullable().optional(),
	systemPrompt: z.string().nullable().optional(),
	thinkingLevel: z
		.unknown()
		.optional()
		.describe("Not accepted: the thinking level belongs in `model`. Sending it is a 400."),
});

export const ModelPresetListResponseSchema = z.object({ presets: z.array(ModelPresetSchema) });

export const ModelPresetResponseSchema = z.object({ preset: ModelPresetSchema });

/** Path parameter of the model preset routes. */
export const ModelPresetKindParamSchema = z.object({ kind: ModelPresetKindSchema });

/** Path parameter of the model provider routes. */
export const ModelProviderIdParamSchema = z.object({ providerId: z.string() });

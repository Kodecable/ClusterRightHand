/**
 * Models, model providers and model presets (doc/design/agent-runtime.md "Model configuration",
 * "Custom providers" and "Model presets").
 */

import type { z } from "zod";
import type {
	AvailableModelSchema,
	CustomApiSchema,
	CustomModelSchema,
	ModelPresetInputSchema,
	ModelPresetKindSchema,
	ModelPresetSchema,
	ModelProviderInputSchema,
	ModelProviderViewSchema,
	ModelRefSchema,
	ModelsResponseSchema,
	SessionIdConfigSchema,
	ThinkingBodyConfigSchema,
	ThinkingConfigSchema,
	ThinkingFormatConfigSchema,
	ThinkingFormatSchema,
	ThinkingLevelLabelsSchema,
	ThinkingLevelSchema,
} from "./schemas/models.ts";

/** pi-ai's thinking levels (doc/design/agent-runtime.md "Thinking levels"). */
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

/** A model choice; an absent thinking level means `off`. */
export type ModelRef = z.infer<typeof ModelRefSchema>;

/** One entry of `GET /api/models`. */
export type AvailableModel = z.infer<typeof AvailableModelSchema>;

/** `GET /api/models`: the offered models and the session model preset's model, when set. */
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

/** The protocol a custom model speaks. */
export type CustomApi = z.infer<typeof CustomApiSchema>;

/** The pi-ai thinking-parameter formats a Chat Completions model may ask for. */
export type ThinkingFormat = z.infer<typeof ThinkingFormatSchema>;

/**
 * Per-level display names of a custom model. A missing key uses the level id
 * itself; an empty string hides the level (doc/design/agent-runtime.md "Thinking levels").
 */
export type ThinkingLevelLabels = z.infer<typeof ThinkingLevelLabelsSchema>;

/** pi-ai generates the thinking parameters (`thinkingFormat`, `thinkingLevelMap`). */
export type ThinkingFormatConfig = z.infer<typeof ThinkingFormatConfigSchema>;

/** The selected level's object is deep-merged into the request body by the payload hook. */
export type ThinkingBodyConfig = z.infer<typeof ThinkingBodyConfigSchema>;

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

/** One model of a custom provider (doc/design/agent-runtime.md "Custom providers"). */
export type CustomModel = z.infer<typeof CustomModelSchema>;

/** Request headers / body paths that carry the crh session id (custom providers). */
export type SessionIdConfig = z.infer<typeof SessionIdConfigSchema>;

export type ModelProviderView = z.infer<typeof ModelProviderViewSchema>;

/** Body of `PUT /api/model-providers/:providerId`. */
export type ModelProviderInput = z.infer<typeof ModelProviderInputSchema>;

/** One model preset kind (doc/design/agent-runtime.md "Model presets"). */
export type ModelPresetKind = z.infer<typeof ModelPresetKindSchema>;

export type ModelPreset = z.infer<typeof ModelPresetSchema>;

/** Body of `PUT /api/model-presets/:kind`; omitted fields stay unchanged, null clears. */
export type ModelPresetInput = z.infer<typeof ModelPresetInputSchema>;

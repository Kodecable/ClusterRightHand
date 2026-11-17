import type { AvailableModel, ModelRef, ThinkingLevel } from "@crh/api";

/** pi-ai's levels, lowest to highest (doc/design/agent-runtime.md "Thinking levels"). */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The available-model entry for a ref; undefined when the list has not loaded or the model is gone. */
export function availableModel(models: AvailableModel[], model: ModelRef | undefined): AvailableModel | undefined {
	return model === undefined
		? undefined
		: models.find((candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId);
}

/**
 * The display name of a level: a custom model's own label when it has one, else the raw pi-ai id. The name is
 * never translated (doc/design/agent-runtime.md "Thinking levels"); custom models expose every offered
 * level's name through `thinkingLabels`.
 */
export function thinkingLevelName(model: AvailableModel | undefined, level: ThinkingLevel): string {
	const label = model?.thinkingLabels?.[level];
	return label !== undefined && label !== "" ? label : level;
}

/** The levels of the selected model; an unknown or unloaded model offers only `off`. */
export function supportedThinkingLevels(models: AvailableModel[], model: ModelRef | undefined): ThinkingLevel[] {
	return availableModel(models, model)?.thinkingLevels ?? ["off"];
}

/** A model reference with an explicit level; `off` is omitted, matching the server's stored shape. */
export function withThinkingLevel(model: ModelRef, level: ThinkingLevel): ModelRef {
	return {
		provider: model.provider,
		modelId: model.modelId,
		...(level === "off" ? {} : { thinkingLevel: level }),
	};
}

import type { AvailableModel, ModelRef, ThinkingLevel } from "@crh/api";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** pi-ai's levels, lowest to highest (doc/design/agent-runtime.md "Thinking levels"). */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const LABELS: Record<ThinkingLevel, MessageDescriptor> = {
	off: msg`Off`,
	minimal: msg`Minimal`,
	low: msg`Low`,
	medium: msg`Medium`,
	high: msg`High`,
	xhigh: msg`Extra high`,
	max: msg`Max`,
};

/** The display name of a thinking level in the active locale. */
export function thinkingLevelLabel(i18n: I18n, level: ThinkingLevel): string {
	return i18n._(LABELS[level]);
}

/** The available-model entry for a ref; undefined when the list has not loaded or the model is gone. */
export function availableModel(models: AvailableModel[], model: ModelRef | undefined): AvailableModel | undefined {
	return model === undefined
		? undefined
		: models.find((candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId);
}

/**
 * The display name of a level: a custom model's own label when it has one, else the localized
 * pi-ai name. Custom models expose every offered level's name through `thinkingLabels`.
 */
export function thinkingLevelName(i18n: I18n, model: AvailableModel | undefined, level: ThinkingLevel): string {
	const label = model?.thinkingLabels?.[level];
	return label !== undefined && label !== "" ? label : thinkingLevelLabel(i18n, level);
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

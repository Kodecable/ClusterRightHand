import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { AvailableModel, ModelRef, ThinkingLevel } from "@/lib/api/types";

/** pi-ai's levels, lowest to highest (doc/agent-runtime.md#思考档位). */
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

/** The levels of the selected model; an unknown or unloaded model offers only `off`. */
export function supportedThinkingLevels(models: AvailableModel[], model: ModelRef | undefined): ThinkingLevel[] {
	const hit =
		model === undefined
			? undefined
			: models.find((candidate) => candidate.provider === model.provider && candidate.modelId === model.modelId);
	return hit?.thinkingLevels ?? ["off"];
}

/** A model reference with an explicit level; `off` is omitted, matching the server's stored shape. */
export function withThinkingLevel(model: ModelRef, level: ThinkingLevel): ModelRef {
	return {
		provider: model.provider,
		modelId: model.modelId,
		...(level === "off" ? {} : { thinkingLevel: level }),
	};
}

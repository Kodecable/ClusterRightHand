import type { ModelRef } from "@crh/api";

/**
 * Reads a stored JSON model reference, ignoring a malformed one. User settings and the model presets
 * share this shape, so both use one parser and cannot disagree about what a stored row means.
 *
 * This lives outside `agent/` so `users/settings.ts` can use it without closing a runtime module cycle
 * back through the agent runtime.
 */
export function parseStoredModelRef(raw: string | null): ModelRef | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as { provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
		if (typeof value.provider !== "string" || typeof value.modelId !== "string") return null;
		return {
			provider: value.provider,
			modelId: value.modelId,
			...(typeof value.thinkingLevel === "string"
				? { thinkingLevel: value.thinkingLevel as ModelRef["thinkingLevel"] }
				: {}),
		};
	} catch {
		return null;
	}
}

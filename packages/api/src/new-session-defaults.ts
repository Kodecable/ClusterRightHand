import type { AvailableModel, ModelRef, ThinkingLevel } from "./models.ts";
import type { UserSettings } from "./user-settings.ts";

export interface ResolvedNewSessionDefaults {
	model: ModelRef | undefined;
	thinkingLevel: ThinkingLevel;
}

const sameModel = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.modelId === b.modelId;

/**
 * A new session's defaults (doc/design/webui.md "New session"): the user's default model, then the
 * session model preset, then the first offered model. A default a provider no longer offers falls
 * through; the thinking level comes with that model and is dropped when the model changed its levels.
 *
 * Shared by the WebUI's new-session page and the chat channels' draft, so the two entry points cannot
 * disagree about the priority or the fallback.
 */
export function resolveNewSessionDefaults(
	available: readonly AvailableModel[],
	settings: UserSettings | null,
	sessionModel: ModelRef | null,
): ResolvedNewSessionDefaults {
	const offered = (candidate: ModelRef | null | undefined): AvailableModel | undefined =>
		candidate === null || candidate === undefined ? undefined : available.find((model) => sameModel(model, candidate));
	for (const candidate of [settings?.defaultModel, sessionModel]) {
		const found = offered(candidate);
		if (found === undefined || candidate === null || candidate === undefined) continue;
		const level =
			candidate.thinkingLevel !== undefined && found.thinkingLevels.includes(candidate.thinkingLevel)
				? candidate.thinkingLevel
				: "off";
		return { model: { provider: found.provider, modelId: found.modelId }, thinkingLevel: level };
	}
	const first = available[0];
	return {
		model: first === undefined ? undefined : { provider: first.provider, modelId: first.modelId },
		thinkingLevel: "off",
	};
}

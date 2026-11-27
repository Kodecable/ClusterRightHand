import { describe, expect, it } from "vitest";
import type { AvailableModel, ModelRef, ThinkingLevel } from "../src/models.ts";
import { resolveNewSessionDefaults } from "../src/new-session-defaults.ts";
import type { UserSettings } from "../src/user-settings.ts";

const model = (provider: string, modelId: string, thinkingLevels: ThinkingLevel[]): AvailableModel => ({
	provider,
	providerName: provider,
	modelId,
	name: modelId,
	contextWindow: 1000,
	thinkingLevels,
	input: ["text"],
});

const settings = (defaultModel: ModelRef | null): UserSettings => ({
	locale: null,
	defaultModel,
	defaultRulePreset: null,
	showProgress: true,
	defaultChannelAccountId: null,
});

describe("resolveNewSessionDefaults", () => {
	const offered = [model("p", "one", ["off", "low"]), model("p", "two", ["off", "high"])];

	it("uses the user's default model and its supported thinking level", () => {
		expect(
			resolveNewSessionDefaults(offered, settings({ provider: "p", modelId: "two", thinkingLevel: "high" }), null),
		).toEqual({
			model: { provider: "p", modelId: "two" },
			thinkingLevel: "high",
		});
	});

	it("falls back to the session preset when the default is no longer offered", () => {
		expect(
			resolveNewSessionDefaults(offered, settings({ provider: "gone", modelId: "nope" }), {
				provider: "p",
				modelId: "one",
				thinkingLevel: "low",
			}),
		).toEqual({ model: { provider: "p", modelId: "one" }, thinkingLevel: "low" });
	});

	it("falls back to the first offered model when neither default is offered", () => {
		expect(
			resolveNewSessionDefaults(offered, settings({ provider: "gone", modelId: "nope" }), {
				provider: "gone",
				modelId: "also-nope",
			}),
		).toEqual({ model: { provider: "p", modelId: "one" }, thinkingLevel: "off" });
	});

	it("drops a thinking level the chosen model does not support", () => {
		expect(
			resolveNewSessionDefaults(offered, settings({ provider: "p", modelId: "one", thinkingLevel: "high" }), null),
		).toEqual({ model: { provider: "p", modelId: "one" }, thinkingLevel: "off" });
	});

	it("has no model when none is offered", () => {
		expect(resolveNewSessionDefaults([], settings(null), null)).toEqual({
			model: undefined,
			thinkingLevel: "off",
		});
	});
});

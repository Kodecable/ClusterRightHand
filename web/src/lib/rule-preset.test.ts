import { ShieldAlertIcon, ShieldEllipsisIcon, ShieldQuestionMarkIcon } from "lucide-react";
import { describe, expect, test } from "vitest";
import { API_TOKEN_RULE_PRESETS, RULE_PRESETS, rulePresetLabel } from "./rule-preset";

describe("rulePresetLabel", () => {
	test("shows the product name, never the raw server value", () => {
		expect(rulePresetLabel("ask")).toBe("Ask");
		expect(rulePresetLabel("auto_review")).toBe("Auto Review");
		expect(rulePresetLabel("yolo")).toBe("Yolo");
	});

	test("has no name for a missing rule preset, and no raw fallback for an unknown one", () => {
		expect(rulePresetLabel(undefined)).toBe("");
		expect(rulePresetLabel(null)).toBe("");
		expect(rulePresetLabel("auto-review")).toBe("");
	});

	test("lists every rule preset once, in menu order", () => {
		expect(RULE_PRESETS.map((entry) => entry.value)).toEqual(["ask", "auto_review", "yolo"]);
	});

	test("offers API tokens only Ask and Yolo", () => {
		expect(API_TOKEN_RULE_PRESETS).toEqual(["ask", "yolo"]);
	});

	test("gives each rule preset its own shield icon", () => {
		expect(RULE_PRESETS.map((entry) => entry.icon)).toEqual([
			ShieldQuestionMarkIcon,
			ShieldEllipsisIcon,
			ShieldAlertIcon,
		]);
	});
});

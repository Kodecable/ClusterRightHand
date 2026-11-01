import { describe, expect, test } from "vitest";
import { PRESETS, presetLabel } from "./preset";

describe("presetLabel", () => {
	test("shows the product name, never the raw server value", () => {
		expect(presetLabel("ask")).toBe("Ask");
		expect(presetLabel("auto_review")).toBe("Auto Review");
		expect(presetLabel("yolo")).toBe("Yolo");
	});

	test("has no name for a missing preset, and no raw fallback for an unknown one", () => {
		expect(presetLabel(undefined)).toBe("");
		expect(presetLabel(null)).toBe("");
		expect(presetLabel("auto-review")).toBe("");
	});

	test("lists every preset once, in menu order", () => {
		expect(PRESETS.map((entry) => entry.value)).toEqual(["ask", "auto_review", "yolo"]);
	});
});

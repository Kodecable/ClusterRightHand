import { describe, expect, test } from "vitest";
import { buildTurnRailItems, outlineText, outlineTurnsFromPages, type RailUserItem } from "./turn-rail-items";

describe("outlineText", () => {
	test("collapses whitespace and trims", () => {
		expect(outlineText("  hello\n\n\tworld  ")).toEqual({ text: "hello world", truncated: false });
		expect(outlineText("")).toEqual({ text: "", truncated: false });
	});

	test("counts Unicode code points, not UTF-16 units, for emoji", () => {
		const result = outlineText("😀".repeat(60));
		expect(Array.from(result.text)).toHaveLength(50);
		expect(result.text).toBe("😀".repeat(50));
		expect(result.truncated).toBe(true);
	});

	test("cuts CJK text at 50 code points", () => {
		const result = outlineText("参考".repeat(30));
		expect(Array.from(result.text)).toHaveLength(50);
		expect(result.text).toBe("参考".repeat(25));
		expect(result.truncated).toBe(true);
	});

	test("keeps a text of exactly 50 code points whole", () => {
		expect(outlineText("a".repeat(50))).toEqual({ text: "a".repeat(50), truncated: false });
		expect(outlineText("a".repeat(51))).toEqual({ text: "a".repeat(50), truncated: true });
	});
});

describe("outlineTurnsFromPages", () => {
	test("reads pages newest chunk first and returns oldest turns first", () => {
		const pages = [
			{ turns: [{ entryId: 8, text: "eight", truncated: false }], cursor: "older" },
			{ turns: [{ entryId: 3, text: "three", truncated: false }], cursor: null },
		];
		expect(outlineTurnsFromPages(pages).map((turn) => turn.entryId)).toEqual([3, 8]);
	});

	test("is empty without pages", () => {
		expect(outlineTurnsFromPages(undefined)).toEqual([]);
	});
});

describe("buildTurnRailItems", () => {
	test("puts unloaded outline turns before loaded items and dedupes by entry id", () => {
		const loaded: RailUserItem[] = [
			{ entryId: "2", text: "already loaded" },
			{ entryId: "10", text: "ten" },
			{ entryId: undefined, text: "live only" },
			{ entryId: "12", text: "  twelve\nlines " },
		];
		const items = buildTurnRailItems(
			[
				{ entryId: 1, text: "one", truncated: false },
				{ entryId: 2, text: "two", truncated: false },
			],
			loaded,
		);
		expect(items).toEqual([
			{ entryId: "1", text: "one", truncated: false, loaded: false },
			{ entryId: "2", text: "already loaded", truncated: false, loaded: true },
			{ entryId: "10", text: "ten", truncated: false, loaded: true },
			{ entryId: "12", text: "twelve lines", truncated: false, loaded: true },
		]);
	});

	test("applies the outline rule to loaded text", () => {
		const items = buildTurnRailItems([], [{ entryId: "1", text: `${"x".repeat(50)}y` }]);
		expect(items[0]?.text).toBe("x".repeat(50));
		expect(items[0]?.truncated).toBe(true);
	});
});

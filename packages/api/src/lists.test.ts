import { describe, expect, it } from "vitest";
import { formatList } from "./lists.ts";

describe("formatList", () => {
	it("uses the locale's list punctuation", () => {
		expect(formatList("en", ["a", "b", "c"])).toBe("a, b, c");
		expect(formatList("zh-CN", ["a", "b", "c"])).toBe("a、b、c");
		expect(formatList("en", ["a", "b"])).toBe("a, b");
		expect(formatList("zh-CN", ["a", "b"])).toBe("a、b");
	});

	it("formats one and no items", () => {
		expect(formatList("en", ["a"])).toBe("a");
		expect(formatList("zh-CN", ["a"])).toBe("a");
		expect(formatList("en", [])).toBe("");
		expect(formatList("zh-CN", [])).toBe("");
	});

	it("accepts readonly arrays", () => {
		const items = ["node-1", "node-2"] as const;
		expect(formatList("en", items)).toBe("node-1, node-2");
	});
});

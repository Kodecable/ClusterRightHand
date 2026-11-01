import { describe, expect, test } from "vitest";
import { formatTokens } from "./format";

describe("formatTokens", () => {
	test("keeps small counts exact and adds an auto unit above a thousand", () => {
		expect(formatTokens(0, "en")).toBe("0");
		expect(formatTokens(999, "en")).toBe("999");
		expect(formatTokens(1_000, "en")).toBe("1K");
		expect(formatTokens(1_234, "en")).toBe("1.2K");
		expect(formatTokens(12_345, "en")).toBe("12.3K");
		expect(formatTokens(1_500_000, "en")).toBe("1.5M");
		expect(formatTokens(3_400_000, "en")).toBe("3.4M");
	});

	test("formats the number with the active locale and keeps the unit", () => {
		expect(formatTokens(1_234, "zh-CN")).toBe("1.2K");
		expect(formatTokens(999, "zh-CN")).toBe("999");
		expect(formatTokens(2_500_000, "zh-CN")).toBe("2.5M");
	});

	test("a value that is not a number reads as zero", () => {
		expect(formatTokens(Number.NaN, "en")).toBe("0");
		expect(formatTokens(Number.POSITIVE_INFINITY, "en")).toBe("0");
	});
});

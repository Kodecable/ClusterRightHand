import { describe, expect, test } from "vitest";
import { cacheHitPercent, formatLatency, formatTokenRate } from "./generation-stat-format";

describe("generation stat formatting", () => {
	test("shows a decode rate as an integer from ten up and with one decimal below", () => {
		expect(formatTokenRate(45, "en")).toBe("45");
		expect(formatTokenRate(10, "en")).toBe("10");
		expect(formatTokenRate(9.56, "en")).toBe("9.6");
		expect(formatTokenRate(0.44, "en")).toBe("0.4");
		expect(formatTokenRate(0, "en")).toBe("0");
	});

	test("shows a latency in seconds from a second up and in milliseconds below", () => {
		expect(formatLatency(1_200, "en")).toBe("1.2s");
		expect(formatLatency(2_000, "en")).toBe("2s");
		expect(formatLatency(850, "en")).toBe("850ms");
	});

	test("floors a cache hit and never shows 100 for an incomplete read", () => {
		expect(cacheHitPercent(7_550, 10_000)).toBe(75);
		expect(cacheHitPercent(9_999, 10_000)).toBe(99);
		expect(cacheHitPercent(10_000, 10_000)).toBe(100);
		expect(cacheHitPercent(0, 10_000)).toBe(0);
		expect(cacheHitPercent(5, 0)).toBeNull();
	});
});

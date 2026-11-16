import { describe, expect, test } from "vitest";
import { formatDateTimeNumeric, formatDateTimeSeconds, formatDuration, formatTokens } from "./format";

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

describe("formatDuration", () => {
	test("writes the one duration shape", () => {
		expect(formatDuration(0, "en")).toBe("0s");
		expect(formatDuration(12_500, "en")).toBe("13s");
		expect(formatDuration(120_000, "en")).toBe("2m 00s");
		expect(formatDuration(90_000, "en")).toBe("1m 30s");
		expect(formatDuration(3_723_000, "en")).toBe("1h 02m");
	});

	test("keeps the active locale's digits and reads an invalid value as a dash", () => {
		expect(formatDuration(90_000, "zh-CN")).toBe("1m 30s");
		expect(formatDuration(Number.NaN, "en")).toBe("–");
		expect(formatDuration(-1, "en")).toBe("–");
	});
});

describe("formatDateTimeSeconds", () => {
	test("writes a compact date and the time down to the second in both locales", () => {
		expect(formatDateTimeSeconds(new Date(2026, 10, 3, 9, 0, 5), "en")).toBe("11/03/2026, 09:00:05");
		expect(formatDateTimeSeconds(new Date(2026, 10, 3, 9, 0, 5), "zh-CN")).toBe("2026/11/03 09:00:05");
	});

	test("uses a 24-hour clock", () => {
		expect(formatDateTimeSeconds(new Date(2026, 10, 3, 21, 30, 5), "en")).toMatch(/21:30:05$/);
	});

	test("an invalid date reads as a dash", () => {
		expect(formatDateTimeSeconds("not a date", "en")).toBe("–");
	});
});

describe("formatDateTimeNumeric", () => {
	test("writes a sortable local timestamp", () => {
		expect(formatDateTimeNumeric(new Date(2026, 10, 3, 9, 0, 0))).toBe("2026-11-03 09:00:00");
	});

	test("an invalid date reads as a dash", () => {
		expect(formatDateTimeNumeric("not a date")).toBe("–");
	});
});

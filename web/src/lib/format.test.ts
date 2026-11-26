import { describe, expect, test } from "vitest";
import {
	escapeHtml,
	formatDateTimeNumeric,
	formatDateTimeSeconds,
	formatDuration,
	formatShortDateTime,
	formatTokens,
} from "./format";

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
		expect(formatDuration(9_000, "en")).toBe("9s");
		expect(formatDuration(12_500, "en")).toBe("13s");
		expect(formatDuration(189_000, "en")).toBe("3m 09s");
		expect(formatDuration(120_000, "en")).toBe("2m 00s");
		expect(formatDuration(90_000, "en")).toBe("1m 30s");
		expect(formatDuration(3_723_000, "en")).toBe("1h 02m");
		expect(formatDuration(18_420_000, "en")).toBe("5h 07m");
		expect(formatDuration(273_600_000, "en")).toBe("3d 04h");
		expect(formatDuration(400 * 86_400_000, "en")).toBe("1y 35d");
	});

	test("puts the day and year boundaries at fixed lengths", () => {
		expect(formatDuration(23 * 3_600_000 + 59 * 60_000, "en")).toBe("23h 59m");
		expect(formatDuration(24 * 3_600_000, "en")).toBe("1d 00h");
		expect(formatDuration(364 * 86_400_000 + 23 * 3_600_000, "en")).toBe("364d 23h");
		expect(formatDuration(365 * 86_400_000, "en")).toBe("1y 0d");
	});

	test("keeps the active locale's digits and reads an invalid value as a dash", () => {
		expect(formatDuration(90_000, "zh-CN")).toBe("1m 30s");
		expect(formatDuration(24 * 3_600_000, "zh-CN")).toBe("1d 00h");
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

describe("formatShortDateTime", () => {
	const now = new Date(2026, 10, 20, 15, 0, 0);

	test("today shows the time alone, 24-hour", () => {
		expect(formatShortDateTime(new Date(2026, 10, 20, 9, 5), "en", now)).toBe("09:05");
		expect(formatShortDateTime(new Date(2026, 10, 20, 21, 30), "zh-CN", now)).toBe("21:30");
	});

	test("an earlier day this year adds the month and day in the locale's order", () => {
		expect(formatShortDateTime(new Date(2026, 10, 19, 23, 59), "en", now)).toBe("11/19, 23:59");
		expect(formatShortDateTime(new Date(2026, 0, 2, 8, 0), "zh-CN", now)).toBe("01/02 08:00");
	});

	test("an earlier year adds the year", () => {
		expect(formatShortDateTime(new Date(2025, 11, 31, 23, 0), "en", now)).toBe("12/31/2025, 23:00");
		expect(formatShortDateTime(new Date(2025, 11, 31, 23, 0), "zh-CN", now)).toBe("2025/12/31 23:00");
	});

	test("an invalid value reads as a dash", () => {
		expect(formatShortDateTime("not a date", "en", now)).toBe("–");
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

describe("escapeHtml", () => {
	test("escapes every character that can start markup", () => {
		expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(escapeHtml("a & b 'c'")).toBe("a &amp; b &#39;c&#39;");
	});
});

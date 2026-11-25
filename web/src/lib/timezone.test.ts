import { describe, expect, test } from "vitest";
import { formatDateTimeSeconds } from "@/lib/format";
import {
	formatZonedDateTime,
	localDateTimeToIso,
	localDateTimeValue,
	zoneLabel,
	zoneLabelFromName,
} from "@/lib/timezone";

describe("time zone labels", () => {
	test("rewrites the GMT forms Intl returns to UTC and keeps real abbreviations", () => {
		expect(zoneLabelFromName("GMT")).toBe("UTC");
		expect(zoneLabelFromName("GMT+8")).toBe("UTC+8");
		expect(zoneLabelFromName("GMT+08:00")).toBe("UTC+08:00");
		expect(zoneLabelFromName("GMT+5:30")).toBe("UTC+5:30");
		expect(zoneLabelFromName("GMT-3")).toBe("UTC-3");
		expect(zoneLabelFromName("SGT")).toBe("SGT");
		expect(zoneLabelFromName("EST")).toBe("EST");
		expect(zoneLabelFromName("CET")).toBe("CET");
		expect(zoneLabelFromName("")).toBe("");
	});

	test("formats a local time followed by the browser's own zone label", () => {
		const date = new Date(Date.UTC(2026, 10, 25, 10, 0, 0));
		const formatted = formatZonedDateTime(date, "en");
		const zone = zoneLabel("en", date);
		expect(zone).not.toBe("");
		expect(formatted).toBe(`${formatDateTimeSeconds(date, "en")} ${zone}`);
		// The zone is a concrete abbreviation or offset, never the word "GMT" or a placeholder.
		expect(formatted.endsWith(zone)).toBe(true);
		expect(formatted).not.toContain("your timezone");
	});

	test("returns a dash for an invalid instant", () => {
		expect(formatZonedDateTime("not-a-time", "en")).toBe("–");
		expect(formatZonedDateTime(null, "en")).toBe("–");
	});
});

describe("datetime-local conversion", () => {
	test("round-trips a local value through an instant", () => {
		const date = new Date(2026, 0, 2, 3, 4, 0, 0);
		const local = localDateTimeValue(date);
		expect(local).toBe("2026-01-02T03:04");
		expect(localDateTimeToIso(local)).toBe(date.toISOString());
	});

	test("reads the value in the browser's zone, not UTC", () => {
		expect(localDateTimeToIso("2026-01-02T03:04")).toBe(new Date(2026, 0, 2, 3, 4).toISOString());
		expect(new Date(localDateTimeToIso("2026-01-02T03:04") as string).getHours()).toBe(3);
	});

	test("rejects an empty or malformed value", () => {
		expect(localDateTimeToIso("")).toBeUndefined();
		expect(localDateTimeToIso("tomorrow")).toBeUndefined();
		expect(localDateTimeToIso("2026-01-02")).toBeUndefined();
		expect(localDateTimeToIso("2026-13-99T99:99")).toBeUndefined();
	});
});

import { afterAll, describe, expect, test } from "vitest";
import { sessionGroup } from "./session-groups";

/**
 * The session list's groups across a DST change: on the spring-forward day a local day is only 23 hours long, so
 * a difference of local midnights in milliseconds is not a whole number of days. The tests build local dates, so
 * they are meaningful only in the zone below; the first test proves the zone took effect.
 */
const originalTz = process.env.TZ;
process.env.TZ = "America/New_York";

afterAll(() => {
	if (originalTz === undefined) delete process.env.TZ;
	else process.env.TZ = originalTz;
});

const at = (year: number, month: number, day: number, hour = 12, minute = 0): Date =>
	new Date(year, month - 1, day, hour, minute, 0, 0);
const iso = (date: Date): string => date.toISOString();

describe("sessionGroup across a DST change", () => {
	test("runs in a zone where 2026-03-08 is 23 hours long", () => {
		// 02:00 jumps to 03:00 on 2026-03-08 in America/New_York.
		const before = new Date(2026, 2, 8, 0, 0).getTime();
		const after = new Date(2026, 2, 9, 0, 0).getTime();
		expect(after - before).toBe(23 * 3_600_000);
	});

	test("a 23-hour local day still counts as one day", () => {
		const now = at(2026, 3, 9);
		expect(sessionGroup(iso(at(2026, 3, 8)), now)).toEqual({ kind: "yesterday" });
	});

	test("days after the change are not off by one", () => {
		const now = at(2026, 3, 10);
		// Two local days back is the "within 7 days" group, not yesterday.
		expect(sessionGroup(iso(at(2026, 3, 8)), now)).toEqual({ kind: "week" });
		// Exactly 7 local days back is already "within 30 days".
		expect(sessionGroup(iso(at(2026, 3, 3)), now)).toEqual({ kind: "month30" });
	});
});

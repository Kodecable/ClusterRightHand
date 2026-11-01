import { describe, expect, test } from "vitest";
import type { SessionListItem } from "@/lib/api/types";
import { groupSessionRows, sessionGroup, sessionGroupKey } from "./session-groups";

/** A local-time date, so the test does not depend on the machine's time zone. */
const at = (year: number, month: number, day: number, hour = 12, minute = 0): Date =>
	new Date(year, month - 1, day, hour, minute, 0, 0);
const iso = (date: Date): string => date.toISOString();

const item = (id: string, updatedAt: string): SessionListItem => ({
	id,
	title: id,
	ownerUserId: "u1",
	ownerName: "Ada",
	scheduleId: null,
	shared: false,
	state: "idle",
	waitingKind: null,
	updatedAt,
});

describe("sessionGroup", () => {
	const now = at(2026, 11, 1);

	test("the day boundary is local midnight", () => {
		expect(sessionGroup(iso(at(2026, 11, 1, 0, 0)), now)).toEqual({ kind: "today" });
		expect(sessionGroup(iso(at(2026, 10, 31, 23, 59)), now)).toEqual({ kind: "yesterday" });
		// A future timestamp (a clock skew) belongs to Today rather than to no group.
		expect(sessionGroup(iso(at(2026, 11, 2, 9, 0)), now)).toEqual({ kind: "today" });
	});

	test("7 days and 30 days are the range boundaries", () => {
		expect(sessionGroup(iso(at(2026, 10, 27)), now)).toEqual({ kind: "week" });
		expect(sessionGroup(iso(at(2026, 10, 26, 0, 0)), now)).toEqual({ kind: "week" });
		// Exactly 7 days back is already "within 30 days", and exactly 30 days back is a month.
		expect(sessionGroup(iso(at(2026, 10, 25, 12, 0)), now)).toEqual({ kind: "month30" });
		expect(sessionGroup(iso(at(2026, 10, 3, 12, 0)), now)).toEqual({ kind: "month30" });
		expect(sessionGroup(iso(at(2026, 10, 2, 12, 0)), now)).toEqual({ kind: "month", month: "2026-10" });
	});

	test("older dates fall into their local calendar month", () => {
		expect(sessionGroup(iso(at(2026, 9, 15)), now)).toEqual({ kind: "month", month: "2026-09" });
		expect(sessionGroup(iso(at(2025, 12, 31)), now)).toEqual({ kind: "month", month: "2025-12" });
		expect(sessionGroupKey({ kind: "month", month: "2026-09" })).toBe("month:2026-09");
		expect(sessionGroupKey({ kind: "today" })).toBe("today");
	});

	test("an unreadable timestamp has no month", () => {
		expect(sessionGroup("not a date", now)).toEqual({ kind: "month", month: "" });
	});
});

describe("groupSessionRows", () => {
	const now = at(2026, 11, 1);

	test("headers sit before their items and only when the group changes", () => {
		const items = [
			item("a", iso(at(2026, 11, 1, 10))),
			item("b", iso(at(2026, 11, 1, 9))),
			item("c", iso(at(2026, 10, 31, 10))),
			item("d", iso(at(2026, 9, 15))),
		];
		const rows = groupSessionRows(items, now);
		expect(rows.map((row) => (row.header ? `#${sessionGroupKey(row.header)}` : (row.item?.id as string)))).toEqual([
			"#today",
			"a",
			"b",
			"#yesterday",
			"c",
			"#month:2026-09",
			"d",
		]);
		// Keys are unique across headers and items.
		expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
	});

	test("an item that moves to the top moves to Today and its old group is regrouped away", () => {
		const old = item("old", iso(at(2026, 9, 15)));
		const moved = { ...old, updatedAt: iso(at(2026, 11, 1, 11)) };
		const rows = groupSessionRows([moved], now);
		expect(rows[0]?.header).toEqual({ kind: "today" });
		expect(rows[1]?.item?.id).toBe("old");
	});

	test("no items is no rows", () => {
		expect(groupSessionRows([], now)).toEqual([]);
	});
});

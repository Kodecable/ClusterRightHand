import type { SessionListItem } from "@/lib/api/types";

/**
 * The session list's date groups (doc/webui.md#侧边列表): Today, Yesterday, Within 7 days, Within 30 days, then
 * one group per calendar month, all read from `updatedAt` — the field the list is sorted by — in the browser's
 * local time zone. Days are calendar days, so a DST change (a 23- or 25-hour local day) cannot shift a group. The
 * grouping is a pure function of the items, so a paged append or a live patch that moves an item to the top
 * regroups the list by itself.
 */
export type SessionGroupKey =
	| { kind: "today" }
	| { kind: "yesterday" }
	| { kind: "week" }
	| { kind: "month30" }
	| { kind: "month"; month: string };

/** One rendered row: a group header or an item. Header rows have no item and item rows no header. */
export interface SessionListRow {
	key: string;
	header?: SessionGroupKey;
	item?: SessionListItem;
}

const DAY_MS = 86_400_000;

/**
 * The local calendar day of a date as a UTC day number. A local day is 23 or 25 hours long across a DST change,
 * but its Y/M/D is exact, so the difference of two day numbers is the number of local days between them.
 */
function localDayNumber(date: Date): number {
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

/** The group of one `updatedAt`; `now` is the caller's clock, so the tests control the day boundary. */
export function sessionGroup(updatedAt: string, now: Date): SessionGroupKey {
	const date = new Date(updatedAt);
	if (Number.isNaN(date.getTime())) return { kind: "month", month: "" };
	const days = localDayNumber(now) - localDayNumber(date);
	if (days <= 0) return { kind: "today" };
	if (days === 1) return { kind: "yesterday" };
	if (days < 7) return { kind: "week" };
	if (days < 30) return { kind: "month30" };
	// The local calendar month, e.g. "2026-09"; the header stays that shape in every locale.
	const month = `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}`;
	return { kind: "month", month };
}

/** A stable key for a group; two headers never share one, so React and virtua see distinct rows. */
export function sessionGroupKey(group: SessionGroupKey): string {
	return group.kind === "month" ? `month:${group.month}` : group.kind;
}

/**
 * The rows of the virtualised list: a header before each run of items in the same group. The items arrive in
 * `updatedAt desc` order, so a group's items are contiguous; an item that moves to the top of the list moves to
 * Today, and the group it left is regrouped away.
 */
export function groupSessionRows(items: readonly SessionListItem[], now: Date): SessionListRow[] {
	const rows: SessionListRow[] = [];
	let current: string | undefined;
	for (const item of items) {
		const group = sessionGroup(item.updatedAt, now);
		const key = sessionGroupKey(group);
		if (key !== current) {
			rows.push({ key: `header:${key}`, header: group });
			current = key;
		}
		rows.push({ key: item.id, item });
	}
	return rows;
}

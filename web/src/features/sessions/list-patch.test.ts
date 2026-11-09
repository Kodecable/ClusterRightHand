import type { CursorPage, SessionListItem } from "@crh/api";
import { describe, expect, test } from "vitest";
import {
	isSessionListItem,
	markSessionListItemRead,
	removeSessionListItem,
	type SessionListFilter,
	sessionListFilter,
	sessionMatchesFilter,
	upsertSessionListItem,
} from "./list-patch";

const item = (overrides: Partial<SessionListItem> = {}): SessionListItem => ({
	id: "s1",
	title: "Deploy the cluster",
	ownerUserId: "me",
	ownerName: "Me",
	scheduleId: null,
	shared: false,
	state: "idle",
	waitingKind: null,
	unread: false,
	updatedAt: "2026-01-01T00:00:00.000Z",
	...overrides,
});

const filter = (overrides: Partial<SessionListFilter> = {}): SessionListFilter => ({
	scope: "mine",
	q: "",
	viewerId: "me",
	isAdmin: false,
	...overrides,
});

const page = (items: SessionListItem[], nextCursor: string | null = null): CursorPage<SessionListItem> => ({
	items,
	nextCursor,
});

describe("sessionMatchesFilter", () => {
	test("mine only shows my sessions", () => {
		expect(sessionMatchesFilter(item(), filter())).toBe(true);
		expect(sessionMatchesFilter(item({ ownerUserId: "someone" }), filter())).toBe(false);
	});

	test("shared shows only sessions shared with me", () => {
		expect(sessionMatchesFilter(item({ ownerUserId: "x", shared: true }), filter({ scope: "shared" }))).toBe(true);
		expect(sessionMatchesFilter(item({ ownerUserId: "me", shared: false }), filter({ scope: "shared" }))).toBe(false);
	});

	test("visible is the owner-and-shared union, the web's only list", () => {
		expect(sessionMatchesFilter(item(), filter({ scope: "visible" }))).toBe(true);
		expect(sessionMatchesFilter(item({ ownerUserId: "x", shared: true }), filter({ scope: "visible" }))).toBe(true);
		expect(sessionMatchesFilter(item({ ownerUserId: "x", shared: false }), filter({ scope: "visible" }))).toBe(false);
	});

	test("ownerId narrows any list to that owner's roots", () => {
		expect(sessionMatchesFilter(item(), filter({ ownerId: "me" }))).toBe(true);
		expect(sessionMatchesFilter(item(), filter({ ownerId: "someone" }))).toBe(false);
		expect(
			sessionMatchesFilter(item({ ownerUserId: "x" }), filter({ scope: "all", isAdmin: true, ownerId: "x" })),
		).toBe(true);
		expect(sessionMatchesFilter(item(), filter({ scope: "all", isAdmin: true, ownerId: "x" }))).toBe(false);
	});

	test("all is admin-only and fails closed", () => {
		expect(sessionMatchesFilter(item(), filter({ scope: "all" }))).toBe(false);
		expect(sessionMatchesFilter(item(), filter({ scope: "all", isAdmin: true }))).toBe(true);
	});

	test("q is a case-insensitive substring of the title", () => {
		expect(sessionMatchesFilter(item(), filter({ q: "deploy" }))).toBe(true);
		expect(sessionMatchesFilter(item(), filter({ q: "  DEPLOY " }))).toBe(true);
		expect(sessionMatchesFilter(item(), filter({ q: "network" }))).toBe(false);
	});

	test("a session with no title yet is listed but never matches a search", () => {
		expect(sessionMatchesFilter(item({ title: null }), filter())).toBe(true);
		expect(sessionMatchesFilter(item({ title: null }), filter({ q: "deploy" }))).toBe(false);
	});
});

describe("sessionListFilter", () => {
	test("carries the ownerId of a per-user list key", () => {
		const viewer = { viewerId: "u1", isAdmin: true };
		expect(sessionListFilter(["sessions", "list", { scope: "all", q: "", ownerId: "u2" }], viewer)).toMatchObject({
			scope: "all",
			ownerId: "u2",
		});
		expect(sessionListFilter(["sessions", "list", { scope: "mine", q: "" }], viewer)).not.toHaveProperty("ownerId");
	});
});

describe("isSessionListItem", () => {
	test("accepts a well-formed row and rejects malformed payloads", () => {
		expect(isSessionListItem(item())).toBe(true);
		expect(isSessionListItem(item({ title: null }))).toBe(true);
		for (const value of [null, undefined, 42, "x", {}, { ...item(), id: "" }, { ...item(), title: 3 }]) {
			expect(isSessionListItem(value), JSON.stringify(value)).toBe(false);
		}
	});

	test("the new state and waiting kind are validated, not guessed", () => {
		expect(isSessionListItem(item({ state: "running" }))).toBe(true);
		expect(isSessionListItem(item({ state: "awaiting", waitingKind: "approval" }))).toBe(true);
		expect(isSessionListItem(item({ state: "awaiting", waitingKind: "authorization" }))).toBe(true);
		expect(isSessionListItem(item({ state: "awaiting", waitingKind: "quota" }))).toBe(true);
		// Old states from before the contract change are not displayed as if they had a meaning.
		for (const state of ["active", "stopped", "busy", "awaiting_approval", ""]) {
			expect(isSessionListItem(item({ state: state as never })), state).toBe(false);
		}
		expect(isSessionListItem({ ...item(), waitingKind: "unknown" })).toBe(false);
		expect(isSessionListItem({ ...item(), waitingKind: undefined })).toBe(true);
	});
});

describe("upsertSessionListItem", () => {
	/** A 2026-01 day, newest first: the tests sort on the string exactly as the server orders it. */
	const at = (day: number): string => `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;

	test("a stream upsert carries the new state fields", () => {
		const pages = [page([item({ id: "a" }), item({ id: "b", state: "idle" })])];
		const next = upsertSessionListItem(
			pages,
			item({ id: "b", state: "awaiting", waitingKind: "quota", updatedAt: "2026-02-01T00:00:00.000Z" }),
			filter(),
		);
		expect(next[0]?.items[0]).toMatchObject({ id: "b", state: "awaiting", waitingKind: "quota" });
		expect(next[0]?.items[1]?.id).toBe("a");
	});

	test("an upsert with an unchanged updatedAt stays in place", () => {
		const pages = [
			page([item({ id: "a", updatedAt: at(3) }), item({ id: "b", updatedAt: at(2) })]),
			page([item({ id: "c", updatedAt: at(1) })]),
		];
		// Marking a tree read changes `unread` but not `updated_at`: the row must not jump to the top.
		const next = upsertSessionListItem(pages, item({ id: "b", updatedAt: at(2), unread: true }), filter());
		expect(next[0]?.items.map((row) => row.id)).toEqual(["a", "b"]);
		expect(next[1]?.items.map((row) => row.id)).toEqual(["c"]);
		expect(next[0]?.items[1]?.unread).toBe(true);
	});

	test("a bumped updatedAt moves the row to the top", () => {
		const pages = [
			page([item({ id: "a", updatedAt: at(3) }), item({ id: "b", updatedAt: at(2) })]),
			page([item({ id: "c", updatedAt: at(1) })]),
		];
		const next = upsertSessionListItem(pages, item({ id: "b", updatedAt: at(4) }), filter());
		expect(next[0]?.items.map((row) => row.id)).toEqual(["b", "a"]);
		expect(next[1]?.items.map((row) => row.id)).toEqual(["c"]);
	});

	test("an older updatedAt lands in the middle, on the page it belongs to", () => {
		const pages = [
			page([item({ id: "a", updatedAt: at(5) }), item({ id: "b", updatedAt: at(4) })]),
			page([item({ id: "c", updatedAt: at(3) }), item({ id: "e", updatedAt: at(1) })]),
		];
		// `b` was on the first page and now sorts between `c` and `e` on the second page.
		const next = upsertSessionListItem(pages, item({ id: "b", updatedAt: at(2) }), filter());
		expect(next[0]?.items.map((row) => row.id)).toEqual(["a"]);
		expect(next[1]?.items.map((row) => row.id)).toEqual(["c", "b", "e"]);
	});

	test("the server's id desc tie-breaker decides equal updatedAt values", () => {
		const pages = [page([item({ id: "d", updatedAt: at(2) }), item({ id: "b", updatedAt: at(2) })])];
		const next = upsertSessionListItem(pages, item({ id: "c", updatedAt: at(2) }), filter());
		expect(next[0]?.items.map((row) => row.id)).toEqual(["d", "c", "b"]);
	});

	test("a row beyond the loaded pages is dropped while more pages remain", () => {
		const pages = [page([item({ id: "a", updatedAt: at(3) }), item({ id: "b", updatedAt: at(2) })], "cursor-2")];
		const dropped = upsertSessionListItem(pages, item({ id: "new", updatedAt: at(1) }), filter());
		expect(dropped[0]?.items.map((row) => row.id)).toEqual(["a", "b"]);
		// A loaded row that became older than every loaded row is removed, not inserted past the cursor.
		const removed = upsertSessionListItem(pages, item({ id: "b", updatedAt: at(1) }), filter());
		expect(removed[0]?.items.map((row) => row.id)).toEqual(["a"]);
	});

	test("a row beyond every loaded row is appended when the list is complete", () => {
		const pages = [page([item({ id: "a", updatedAt: at(3) })]), page([item({ id: "b", updatedAt: at(2) })])];
		const next = upsertSessionListItem(pages, item({ id: "new", updatedAt: at(1) }), filter());
		expect(next[0]?.items.map((row) => row.id)).toEqual(["a"]);
		expect(next[1]?.items.map((row) => row.id)).toEqual(["b", "new"]);
	});

	test("inserts a new matching row at the top", () => {
		const pages = [page([item({ id: "old" })]), page([item({ id: "older" })], "cursor-2")];
		const next = upsertSessionListItem(
			pages,
			item({ id: "new", title: "New", updatedAt: "2026-02-01T00:00:00.000Z" }),
			filter(),
		);
		expect(next[0]?.items.map((row) => row.id)).toEqual(["new", "old"]);
		expect(next[1]?.items.map((row) => row.id)).toEqual(["older"]);
	});

	test("moves an updated row to the top and replaces it", () => {
		const pages = [page([item({ id: "a" }), item({ id: "b", title: "B" })]), page([item({ id: "c" })])];
		const next = upsertSessionListItem(pages, item({ id: "c", title: "C updated" }), filter());
		expect(next[0]?.items.map((row) => row.id)).toEqual(["c", "a", "b"]);
		expect(next[1]?.items.map((row) => row.id)).toEqual([]);
		expect(next[0]?.items[0]?.title).toBe("C updated");
	});

	test("removes a row that no longer matches the filter", () => {
		const pages = [page([item({ id: "a" }), item({ id: "b" })])];
		const next = upsertSessionListItem(pages, item({ id: "a", title: "Unrelated" }), filter({ q: "deploy" }));
		expect(next[0]?.items.map((row) => row.id)).toEqual(["b"]);
	});

	test("does not invent a first page when nothing is loaded", () => {
		const pages: CursorPage<SessionListItem>[] = [];
		expect(upsertSessionListItem(pages, item({ id: "new" }), filter())).toBe(pages);
	});

	test("an empty loaded page receives the row", () => {
		const next = upsertSessionListItem([page([])], item({ id: "new" }), filter());
		expect(next[0]?.items.map((row) => row.id)).toEqual(["new"]);
	});

	test("scope changes drop a row that no longer matches", () => {
		const pages = [page([item({ id: "a", shared: false })])];
		const next = upsertSessionListItem(pages, item({ id: "a", shared: false }), filter({ scope: "shared" }));
		expect(next[0]?.items).toEqual([]);
	});
});

describe("removeSessionListItem", () => {
	test("removes the row from every page", () => {
		const pages = [page([item({ id: "a" }), item({ id: "b" })]), page([item({ id: "a" })])];
		const next = removeSessionListItem(pages, "a");
		expect(next[0]?.items.map((row) => row.id)).toEqual(["b"]);
		expect(next[1]?.items).toEqual([]);
	});

	test("returns the same array when nothing matched", () => {
		const pages = [page([item({ id: "a" })])];
		expect(removeSessionListItem(pages, "zzz")).toBe(pages);
	});
});

describe("markSessionListItemRead", () => {
	test("clears the unread flag of the root in every page", () => {
		const pages = [page([item({ id: "a", unread: true }), item({ id: "b" })]), page([item({ id: "a", unread: true })])];
		const next = markSessionListItemRead(pages, "a");
		expect(next[0]?.items.map((row) => [row.id, row.unread])).toEqual([
			["a", false],
			["b", false],
		]);
		expect(next[1]?.items[0]?.unread).toBe(false);
	});

	test("returns the same array when the row is already read", () => {
		const pages = [page([item({ id: "a", unread: false })])];
		expect(markSessionListItemRead(pages, "a")).toBe(pages);
	});
});

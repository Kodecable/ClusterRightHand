import { describe, expect, test } from "vitest";
import type { CursorPage, SessionListItem } from "@/lib/api/types";
import {
	isSessionListItem,
	removeSessionListItem,
	type SessionListFilter,
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
	waitingLevelId: null,
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

	test("all is admin-only and fails closed", () => {
		expect(sessionMatchesFilter(item(), filter({ scope: "all" }))).toBe(false);
		expect(sessionMatchesFilter(item(), filter({ scope: "all", isAdmin: true }))).toBe(true);
	});

	test("q is a case-insensitive substring of the title", () => {
		expect(sessionMatchesFilter(item(), filter({ q: "deploy" }))).toBe(true);
		expect(sessionMatchesFilter(item(), filter({ q: "  DEPLOY " }))).toBe(true);
		expect(sessionMatchesFilter(item(), filter({ q: "network" }))).toBe(false);
	});
});

describe("isSessionListItem", () => {
	test("accepts a well-formed row and rejects malformed payloads", () => {
		expect(isSessionListItem(item())).toBe(true);
		for (const value of [null, undefined, 42, "x", {}, { ...item(), id: "" }, { ...item(), title: 3 }]) {
			expect(isSessionListItem(value), JSON.stringify(value)).toBe(false);
		}
	});
});

describe("upsertSessionListItem", () => {
	test("inserts a new matching row at the top", () => {
		const pages = [page([item({ id: "old" })]), page([item({ id: "older" })], "cursor-2")];
		const next = upsertSessionListItem(pages, item({ id: "new", title: "New" }), filter());
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

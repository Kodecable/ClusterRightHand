import type { CursorPage, SessionListItem, SessionListScope } from "@crh/api";

/**
 * The session-list SSE patch, as pure functions (doc/webui.md "会话列表实时推送"):
 * `upsert` inserts, moves or replaces at the row's sort position while respecting
 * the active `scope` and `q`; `remove` drops the row. The hook only supplies the
 * filter and writes the result into the Query cache.
 */

export interface SessionListFilter {
	scope: SessionListScope;
	q: string;
	/** Only roots owned by this user, for the per-user list on a user's page. */
	ownerId?: string;
	viewerId: string;
	isAdmin: boolean;
}

const STATES = new Set(["idle", "running", "awaiting"]);
const WAITING_KINDS = new Set(["quota", "approval", "authorization"]);

/**
 * Minimal runtime shape check for untrusted stream payloads; anything off is
 * ignored. The state and wait kind are checked against the contract's unions:
 * a payload with a value this client does not know is dropped rather than
 * displayed with a guessed meaning.
 */
export function isSessionListItem(value: unknown): value is SessionListItem {
	if (value === null || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	if (
		typeof item.id !== "string" ||
		item.id === "" ||
		(item.title !== null && typeof item.title !== "string") ||
		typeof item.ownerUserId !== "string" ||
		typeof item.state !== "string" ||
		!STATES.has(item.state) ||
		typeof item.updatedAt !== "string"
	) {
		return false;
	}
	return (
		item.waitingKind === null ||
		item.waitingKind === undefined ||
		(typeof item.waitingKind === "string" && WAITING_KINDS.has(item.waitingKind))
	);
}

/**
 * The list filter a query key stands for, or null when the key is not a session-list page. Both the
 * session-list stream and the create-session insertion read the filter from the cache key this way.
 */
export function sessionListFilter(
	queryKey: readonly unknown[],
	viewer: { viewerId: string; isAdmin: boolean },
): SessionListFilter | null {
	const params = queryKey[2];
	if (params === null || typeof params !== "object") return null;
	const record = params as Record<string, unknown>;
	if (typeof record.scope !== "string" || typeof record.q !== "string") return null;
	return {
		scope: record.scope as SessionListScope,
		q: record.q,
		...(typeof record.ownerId === "string" && record.ownerId !== "" ? { ownerId: record.ownerId } : {}),
		viewerId: viewer.viewerId,
		isAdmin: viewer.isAdmin,
	};
}

/** Whether a row belongs in a list with these filters. `all` is never allowed for a non-admin. */
export function sessionMatchesFilter(item: SessionListItem, filter: SessionListFilter): boolean {
	if (filter.scope === "all" && !filter.isAdmin) return false;
	if (filter.scope === "mine" && item.ownerUserId !== filter.viewerId) return false;
	if (filter.scope === "shared" && !item.shared) return false;
	if (filter.scope === "visible" && item.ownerUserId !== filter.viewerId && !item.shared) return false;
	if (filter.ownerId !== undefined && item.ownerUserId !== filter.ownerId) return false;
	const query = filter.q.trim().toLowerCase();
	// A null title is not searchable: the list search matches stored titles only.
	if (query !== "" && !(item.title?.toLowerCase().includes(query) ?? false)) return false;
	return true;
}

type Pages = readonly CursorPage<SessionListItem>[];

/** Removes a row from every loaded page; returns the same array when nothing matched. */
export function removeSessionListItem(pages: Pages, id: string): CursorPage<SessionListItem>[] {
	let changed = false;
	const next = pages.map((page) => {
		if (!page.items.some((item) => item.id === id)) return page;
		changed = true;
		return { ...page, items: page.items.filter((item) => item.id !== id) };
	});
	return changed ? next : (pages as CursorPage<SessionListItem>[]);
}

/**
 * Clears a root's unread flag in every loaded page, for an optimistic read (doc/webui.md "侧边列表");
 * returns the same array when no row changed. Only a root is in the list, so the caller passes the root id
 * even when a child page marked its tree read.
 */
export function markSessionListItemRead(pages: Pages, id: string): CursorPage<SessionListItem>[] {
	let changed = false;
	const next = pages.map((page) => {
		if (!page.items.some((item) => item.id === id && item.unread)) return page;
		changed = true;
		return { ...page, items: page.items.map((item) => (item.id === id ? { ...item, unread: false } : item)) };
	});
	return changed ? next : (pages as CursorPage<SessionListItem>[]);
}

/**
 * Applies one `upsert`: the row is placed where the server's order puts it (`updatedAt desc, id desc`), so
 * an upsert that does not bump `updated_at` (an unread/state change, marking a tree read) leaves it where it
 * was and the date groups stay ordered. A row that no longer matches the filter is only removed. An empty
 * page cache is left alone: the first page has not loaded yet and will include the row.
 */
export function upsertSessionListItem(
	pages: Pages,
	item: SessionListItem,
	filter: SessionListFilter,
): CursorPage<SessionListItem>[] {
	if (!sessionMatchesFilter(item, filter)) return removeSessionListItem(pages, item.id);
	// An upsert that leaves the sort key alone (unread, state, per-call stats) replaces the row where it is,
	// without crossing a page boundary. Only a row whose key no longer fits between its neighbours moves.
	const inPlace = replaceSessionListItemInPlace(pages, item);
	if (inPlace !== undefined) return inPlace;
	const without = removeSessionListItem(pages, item.id);
	if (without.length === 0) return without;
	return insertSessionListItem(without, item);
}

/**
 * The list order of server/src/agent/session-list.ts `orderBy`, which the date grouping relies on:
 * `updated_at desc, id desc`. The server writes `updated_at` as `new Date().toISOString()`, so comparing the
 * strings is comparing the instants, and the id tie-breaker is the same descending comparison the keyset
 * cursor uses.
 */
function compareSessionListOrder(a: SessionListItem, b: SessionListItem): number {
	if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
	if (a.id !== b.id) return a.id > b.id ? -1 : 1;
	return 0;
}

/** The one page and offset a row is on, or undefined when it is absent or duplicated. */
function locateSessionListItem(pages: Pages, id: string): { pageIndex: number; itemIndex: number } | undefined {
	let located: { pageIndex: number; itemIndex: number } | undefined;
	for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
		const itemIndex = (pages[pageIndex] as CursorPage<SessionListItem>).items.findIndex((row) => row.id === id);
		if (itemIndex === -1) continue;
		// A duplicate cannot be replaced in place: the remove path drops every copy first.
		if (located !== undefined) return undefined;
		located = { pageIndex, itemIndex };
	}
	return located;
}

/** The row before `pageIndex`/`itemIndex` in the loaded concatenation, skipping emptied pages. */
function lastItemBefore(pages: Pages, pageIndex: number, itemIndex: number): SessionListItem | undefined {
	const page = pages[pageIndex] as CursorPage<SessionListItem>;
	if (itemIndex > 0) return page.items[itemIndex - 1];
	for (let index = pageIndex - 1; index >= 0; index--) {
		const items = (pages[index] as CursorPage<SessionListItem>).items;
		const last = items[items.length - 1];
		if (last !== undefined) return last;
	}
	return undefined;
}

/** The row after `pageIndex`/`itemIndex` in the loaded concatenation, skipping emptied pages. */
function firstItemAfter(pages: Pages, pageIndex: number, itemIndex: number): SessionListItem | undefined {
	const page = pages[pageIndex] as CursorPage<SessionListItem>;
	for (let index = itemIndex + 1; index < page.items.length; index++) {
		const row = page.items[index];
		if (row !== undefined) return row;
	}
	for (let index = pageIndex + 1; index < pages.length; index++) {
		const first = (pages[index] as CursorPage<SessionListItem>).items[0];
		if (first !== undefined) return first;
	}
	return undefined;
}

/**
 * Replaces an existing row in place when its sort key still fits between the same neighbours it had, which is
 * the common case: an upsert that does not change `updatedAt` (marking a tree read, a state or unread flag)
 * must not move, and a small timestamp change that does not cross a neighbour must not jump pages either.
 * Undefined when the row is new or has to move, so the caller inserts it at its new sorted position.
 */
function replaceSessionListItemInPlace(pages: Pages, item: SessionListItem): CursorPage<SessionListItem>[] | undefined {
	const located = locateSessionListItem(pages, item.id);
	if (located === undefined) return undefined;
	const { pageIndex, itemIndex } = located;
	const page = pages[pageIndex] as CursorPage<SessionListItem>;
	const old = page.items[itemIndex] as SessionListItem;
	const before = lastItemBefore(pages, pageIndex, itemIndex);
	const after = firstItemAfter(pages, pageIndex, itemIndex);
	// More pages exist and the row would now sit past every loaded row: it belongs to a page that is not
	// loaded, and the next fetch brings it. (An unchanged key stays: it already was the last loaded row.)
	const lastPage = pages[pages.length - 1] as CursorPage<SessionListItem>;
	if (after === undefined && lastPage.nextCursor !== null && old.updatedAt !== item.updatedAt) return undefined;
	const fits =
		(before === undefined || compareSessionListOrder(before, item) < 0) &&
		(after === undefined || compareSessionListOrder(item, after) < 0);
	if (!fits) return undefined;
	const items = page.items.slice();
	items[itemIndex] = item;
	const next = pages.slice() as CursorPage<SessionListItem>[];
	next[pageIndex] = { ...page, items };
	return next;
}

/**
 * Inserts a row into the loaded pages without breaking their order: the first loaded row it sorts before
 * decides the page and the offset, so the row lands in the page it belongs to. A row that sorts after every
 * loaded row belongs to a page that is not loaded yet when the last page has a next cursor (that fetch will
 * bring it, so patching it in here would put it above rows that sort before it); otherwise it is appended to
 * the last page. `pages` is not modified.
 */
function insertSessionListItem(
	pages: CursorPage<SessionListItem>[],
	item: SessionListItem,
): CursorPage<SessionListItem>[] {
	for (let index = 0; index < pages.length; index++) {
		const page = pages[index] as CursorPage<SessionListItem>;
		const offset = page.items.findIndex((row) => compareSessionListOrder(item, row) < 0);
		if (offset === -1) continue;
		const items = page.items.slice();
		items.splice(offset, 0, item);
		const next = pages.slice();
		next[index] = { ...page, items };
		return next;
	}
	const lastIndex = pages.length - 1;
	const last = pages[lastIndex] as CursorPage<SessionListItem>;
	if (last.nextCursor !== null) return pages;
	const next = pages.slice();
	next[lastIndex] = { ...last, items: [...last.items, item] };
	return next;
}

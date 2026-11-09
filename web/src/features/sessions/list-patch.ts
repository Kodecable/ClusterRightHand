import type { CursorPage, SessionListItem, SessionListScope } from "@crh/api";

/**
 * The session-list SSE patch, as pure functions (doc/webui.md "会话列表实时推送"):
 * `upsert` inserts, moves to top or replaces while respecting the active
 * `scope` and `q`; `remove` drops the row. The hook only supplies the filter
 * and writes the result into the Query cache.
 */

export interface SessionListFilter {
	scope: SessionListScope;
	q: string;
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
 * Applies one `upsert`. The new/updated row goes to the top of the first page
 * (the list is sorted by `updated_at desc`); a row that no longer matches the
 * filter is only removed. An empty page cache is left alone: the first page has
 * not loaded yet and will include the row.
 */
export function upsertSessionListItem(
	pages: Pages,
	item: SessionListItem,
	filter: SessionListFilter,
): CursorPage<SessionListItem>[] {
	const without = removeSessionListItem(pages, item.id);
	if (!sessionMatchesFilter(item, filter)) return without;
	if (without.length === 0) return without;
	const [first, ...rest] = without as CursorPage<SessionListItem>[];
	if (!first) return without;
	return [{ ...first, items: [item, ...first.items] }, ...rest];
}

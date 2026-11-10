import type {
	CursorPage,
	SessionChildrenSummary,
	SessionListItem,
	SessionListScope,
	SessionPatch,
	SessionSearchPage,
	SessionShare,
	SessionView,
} from "@crh/api";
import {
	type InfiniteData,
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invalidatePendingDecisions } from "@/features/approvals/api";
import { enc, http, queryString } from "@/lib/api/client";
import { flattenCursorPages, prefetchCursorInfiniteQuery, useCursorInfiniteQuery } from "@/lib/api/query";
import { markSessionListItemRead, sessionListFilter, upsertSessionListItem } from "./list-patch";
import { subscribeSessionListUpserts } from "./list-stream-bus";
import type { SessionEntriesPage } from "./session-events";

/** Query keys for every session-shaped query. The list key carries its `scope`/`ownerId`. */
export const sessionKeys = {
	all: ["sessions"] as const,
	list: () => ["sessions", "list"] as const,
	listPage: (scope: string, ownerId = "", limit?: number) =>
		["sessions", "list", { scope, ownerId, ...(limit === undefined ? {} : { limit }) }] as const,
	search: (scope: string, q: string) => ["sessions", "search", { scope, q }] as const,
	detail: (id: string) => ["sessions", "detail", id] as const,
	children: (id: string) => ["sessions", "children", id] as const,
	childrenSummary: (id: string) => ["sessions", "children-summary", id] as const,
	entries: (id: string, before: string) => ["sessions", "entries", id, before] as const,
	shares: (id: string) => ["sessions", "shares", id] as const,
};

/**
 * The web's only list scope: the roots the caller owns plus the ones shared with
 * them. The search dialog searches the same scope so a hit is always a session
 * the list shows.
 */
export const SESSION_LIST_SCOPE: SessionListScope = "visible";

export interface SessionListParams {
	/** Defaults to `visible`, the only scope the web uses. */
	scope?: SessionListScope;
	/** Only roots owned by this user; on `scope=all` this is the per-user session list. */
	ownerId?: string;
	/** Rows per page; omitted keeps the server default. A detail page's recent list asks for 10. */
	limit?: number;
}

interface ResolvedSessionListParams extends Required<Omit<SessionListParams, "limit">> {
	limit?: number;
}

function listParams({ scope = SESSION_LIST_SCOPE, ownerId = "", limit }: SessionListParams): ResolvedSessionListParams {
	return limit === undefined ? { scope, ownerId } : { scope, ownerId, limit };
}

function fetchSessionsPage(
	{ scope, ownerId, limit }: ResolvedSessionListParams,
	cursor: string | undefined,
	signal: AbortSignal,
): Promise<CursorPage<SessionListItem>> {
	return http.get<CursorPage<SessionListItem>>(`/sessions${queryString({ scope, ownerId, limit, cursor })}`, {
		signal,
	});
}

export function useSessions(params: SessionListParams = {}) {
	const { scope, ownerId, limit } = listParams(params);
	return useCursorInfiniteQuery<SessionListItem>({
		queryKey: sessionKeys.listPage(scope, ownerId, limit),
		fetchPage: (cursor, signal) => fetchSessionsPage({ scope, ownerId, limit }, cursor, signal),
	});
}

/**
 * `GET /api/sessions/search` pages (doc/design/webui.md "Session content search"): every keyword
 * matches the title or a message of the root's tree. Disabled for an empty
 * query; the caller debounces the text before passing it here. The page type is
 * kept whole because `contentSearch` (titles-only on SQLite) comes on every page.
 */
export function useSessionSearch(q: string, scope: SessionListScope = SESSION_LIST_SCOPE) {
	return useInfiniteQuery<
		SessionSearchPage,
		Error,
		InfiniteData<SessionSearchPage, string | null>,
		readonly unknown[],
		string | null
	>({
		queryKey: sessionKeys.search(scope, q),
		enabled: q !== "",
		initialPageParam: null,
		queryFn: ({ pageParam, signal }) =>
			http.get<SessionSearchPage>(`/sessions/search${queryString({ q, scope, cursor: pageParam })}`, { signal }),
		getNextPageParam: (page) => page.nextCursor,
	});
}

/**
 * Start the first session-list page before the sessions layout mounts (the
 * startup path in `main.tsx`), so the mocked/server round trip overlaps React's
 * render of the shell. The `useSessions` hook joins the same query.
 */
export function prefetchSessions(queryClient: QueryClient, params: SessionListParams): Promise<void> {
	const { scope, ownerId, limit } = listParams(params);
	return prefetchCursorInfiniteQuery<SessionListItem>(queryClient, {
		queryKey: sessionKeys.listPage(scope, ownerId, limit),
		fetchPage: (cursor, signal) => fetchSessionsPage({ scope, ownerId, limit }, cursor, signal),
	});
}

async function fetchSession(id: string, signal: AbortSignal): Promise<SessionView> {
	const result = await http.get<{ session: SessionView; shares?: SessionShare[] }>(`/sessions/${enc(id)}`, { signal });
	return { ...result.session, shares: result.shares };
}

export function useSession(id: string | undefined) {
	return useQuery({
		queryKey: sessionKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) => fetchSession(id ?? "", signal),
	});
}

/**
 * The id of the tree's root, found by following `parentSessionId` up. The
 * session list stream only publishes roots, so a page needs this id to know
 * which upsert concerns its tree (doc/design/webui.md "API conventions"); a root page resolves
 * without a request. Undefined while the chain is still loading.
 */
export function useSessionRootId(session: SessionView | undefined): string | undefined {
	const sessionId = session?.id;
	const parentSessionId = session?.parentSessionId ?? null;
	// The discovered chain is stored with the session it belongs to, so a switch
	// to another tree renders with that tree's first parent immediately.
	const [chain, setChain] = useState<{ sessionId: string | undefined; ids: string[] }>(() => ({
		sessionId,
		ids: parentSessionId === null ? [] : [parentSessionId],
	}));
	const ids = chain.sessionId === sessionId ? chain.ids : parentSessionId === null ? [] : [parentSessionId];

	useEffect(() => {
		setChain((current) => {
			if (current.sessionId === sessionId) return current;
			return { sessionId, ids: parentSessionId === null ? [] : [parentSessionId] };
		});
	}, [parentSessionId, sessionId]);

	const queries = useQueries({
		queries: ids.map((id) => ({
			queryKey: sessionKeys.detail(id),
			queryFn: ({ signal }: { signal: AbortSignal }) => fetchSession(id, signal),
		})),
	});
	const last = queries[queries.length - 1]?.data;
	const lastParentId = last?.parentSessionId ?? null;

	useEffect(() => {
		if (lastParentId === null || sessionId === undefined) return;
		setChain((current) => {
			if (current.sessionId !== sessionId || current.ids.includes(lastParentId)) return current;
			return { sessionId, ids: [...current.ids, lastParentId] };
		});
	}, [lastParentId, sessionId]);

	if (session === undefined) return undefined;
	if (parentSessionId === null) return session.id;
	return last !== undefined && lastParentId === null ? last.id : undefined;
}

/**
 * A session's direct child sessions (`GET /sessions/:id/children`), newest
 * first, one cursor page at a time. The list is refetched on the three events
 * the contract names: the session's `snapshot` (`revision`), a `subagent` tool
 * update or end (`revision` too, see `useSessionEvents`) and the tree root's
 * `upsert` on the session list stream (`rootId`).
 */
export function useSessionChildren(id: string | undefined, rootId: string | undefined, revision: number) {
	const queryClient = useQueryClient();
	const children = useCursorInfiniteQuery<SessionListItem>({
		queryKey: sessionKeys.children(id ?? ""),
		enabled: id !== undefined && id !== "",
		fetchPage: (cursor, signal) =>
			http.get<CursorPage<SessionListItem>>(`/sessions/${enc(id ?? "")}/children${queryString({ cursor })}`, {
				signal,
			}),
	});

	useEffect(() => {
		if (id === undefined || id === "" || rootId === undefined || revision === 0) return;
		void queryClient.invalidateQueries({ queryKey: sessionKeys.children(id) });
		void queryClient.invalidateQueries({ queryKey: sessionKeys.childrenSummary(id) });
	}, [id, rootId, revision, queryClient]);

	useEffect(() => {
		if (id === undefined || id === "" || rootId === undefined) return;
		return subscribeSessionListUpserts((item) => {
			if (item.id !== rootId) return;
			void queryClient.invalidateQueries({ queryKey: sessionKeys.children(id) });
			void queryClient.invalidateQueries({ queryKey: sessionKeys.childrenSummary(id) });
		});
	}, [id, rootId, queryClient]);

	return children;
}

/** The page's children query, as the children bar receives it. */
export type SessionChildrenQuery = ReturnType<typeof useSessionChildren>;

/**
 * The direct child counts of the children bar (`GET /sessions/:id/children/summary`): the
 * compact line needs the number per state without loading every page. Refetched by
 * `useSessionChildren`, whose three events are the same ones this count follows.
 */
export function useSessionChildrenSummary(id: string | undefined) {
	return useQuery({
		queryKey: sessionKeys.childrenSummary(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<SessionChildrenSummary>(`/sessions/${enc(id ?? "")}/children/summary`, { signal }),
	});
}

/**
 * One level of the subagent tree inside the children bar: the session's direct children, one
 * cursor page at a time. A nested level only queries once it is expanded, so the tree stays
 * lazy; the first level shares the page's `useSessionChildren` cache.
 */
export function useSessionTreeChildren(id: string, enabled: boolean) {
	return useCursorInfiniteQuery<SessionListItem>({
		queryKey: sessionKeys.children(id),
		enabled,
		fetchPage: (cursor, signal) =>
			http.get<CursorPage<SessionListItem>>(`/sessions/${enc(id)}/children${queryString({ cursor })}`, { signal }),
	});
}

/**
 * The tree's aggregate row as the loaded session lists already carry it. The
 * list stream patches those pages with the same `SessionListItem`, so reading
 * them here is current without another request, and a stop button is right on
 * a page that opened before any upsert arrived.
 */
function useCachedSessionListItem(id: string | undefined): SessionListItem | undefined {
	const queryClient = useQueryClient();
	const cache = useRef<{
		queryClient: QueryClient;
		id: string | undefined;
		item: SessionListItem | undefined;
		dirty: boolean;
	}>({ queryClient, id, item: undefined, dirty: true });

	const subscribe = useCallback(
		(notify: () => void) =>
			queryClient.getQueryCache().subscribe((event) => {
				// Session detail, children and approval updates must not rescan the
				// list pages; only the list's own queries can change this item.
				if (!matchesSessionListKey(event.query.queryKey)) return;
				cache.current.dirty = true;
				notify();
			}),
		[queryClient],
	);
	const read = useCallback(() => {
		const current = cache.current;
		if (current.queryClient !== queryClient || current.id !== id) {
			current.queryClient = queryClient;
			current.id = id;
			current.item = undefined;
			current.dirty = true;
		}
		if (!current.dirty) return current.item;
		let item: SessionListItem | undefined;
		if (id !== undefined && id !== "") {
			for (const [, data] of queryClient.getQueriesData<SessionListData>({ queryKey: sessionKeys.list() })) {
				item = flattenCursorPages(data).find((candidate) => candidate.id === id);
				if (item !== undefined) break;
			}
		}
		current.item = item;
		current.dirty = false;
		return item;
	}, [queryClient, id]);
	return useSyncExternalStore(subscribe, read);
}

/** Whether a query key belongs to a loaded session list page (`["sessions", "list", …]`). */
function matchesSessionListKey(queryKey: readonly unknown[]): boolean {
	const listKey = sessionKeys.list();
	return listKey.every((part, index) => queryKey[index] === part);
}

/**
 * Keeps the session view current from the session list stream. That stream
 * only publishes a tree's root, so its upsert is the one notification that a
 * session inside the tree changed (doc/design/webui.md "Session list API"). The item
 * carries the tree's aggregate, not the session's own state
 * (doc/design/agent-runtime.md "Session state"), so the detail is refetched instead of
 * overwritten; the aggregate is returned for the consumers that really concern
 * the whole tree (the Stop button and the waiting cards of a root).
 *
 * A tree that starts or stops waiting refreshes the approvals list: that is
 * when a decision card appears or goes away, including when someone else
 * decided it.
 */
export function useSessionTreeSync(
	sessionId: string | undefined,
	rootId: string | undefined,
): SessionListItem | undefined {
	const queryClient = useQueryClient();
	// The stream only has to be followed for a root the loaded lists do not carry.
	const [published, setPublished] = useState<SessionListItem>();

	useEffect(() => {
		if (sessionId === undefined || sessionId === "" || rootId === undefined || rootId === "") return;
		// A new page starts from no previous aggregate; a tree leaving a wait is
		// then the one transition into not awaiting.
		let previous: SessionListItem | undefined;
		return subscribeSessionListUpserts((item) => {
			if (item.id !== rootId) return;
			setPublished(item);
			void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(sessionId) });
			const awaiting = item.state === "awaiting";
			const wasAwaiting = previous?.state === "awaiting";
			const waitChanged = awaiting && previous?.waitingKind !== item.waitingKind;
			previous = item;
			if (awaiting !== wasAwaiting || waitChanged) invalidatePendingDecisions(queryClient);
		});
	}, [sessionId, rootId, queryClient]);

	const cached = useCachedSessionListItem(rootId);
	if (cached !== undefined) return cached;
	return published?.id === rootId ? published : undefined;
}

export type { SessionEntriesPage } from "./session-events";

/**
 * One page of older entries: `before` is the `historyCursor` of the page that
 * follows it. Entries are returned oldest to newest and belong *before* the
 * already loaded ones; the session view's `prependHistory` reducer adds them
 * without touching the live stream. The query only runs when the reader
 * scrolls to the top (`enabled`), one page per reach of the top.
 */
export function useSessionHistoryPage(id: string | undefined, before: string | null, enabled: boolean) {
	return useQuery({
		queryKey: sessionKeys.entries(id ?? "", before ?? ""),
		enabled: enabled && id !== undefined && id !== "" && before !== null,
		queryFn: ({ signal }) =>
			http.get<SessionEntriesPage>(`/sessions/${enc(id ?? "")}/entries${queryString({ before, limit: 100 })}`, {
				signal,
			}),
		// The page must not be taken from a stale cache after the live stream moved
		// on; it is fetched when requested and kept for the current view only.
		staleTime: 0,
		gcTime: 60_000,
	});
}

export function useSessionShares(id: string | undefined) {
	return useQuery({
		queryKey: sessionKeys.shares(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: ({ signal }) =>
			http.get<{ shares: SessionShare[] }>(`/sessions/${enc(id ?? "")}/shares`, { signal }).then((r) => r.shares),
	});
}

export interface CreateSessionInput {
	/** The draft's idempotency key: one request id creates one session and submits one message. */
	requestId: string;
	message: string;
	title?: string;
	model: SessionView["model"];
	rulePreset: string;
	/** The new session's remaining budget; null or omitted: unlimited. */
	budgetRemaining?: number | null;
}

/**
 * The error stays on the draft page's own line; the caller inserts the returned session into the list it
 * came from, so no list invalidation races that insertion.
 */
export function useCreateSession() {
	return useMutation({
		mutationFn: (input: CreateSessionInput) =>
			http.post<{ session: SessionView }>("/sessions", input).then((r) => r.session),
		meta: { toast: false },
	});
}

/** The list row of a session the caller just created: its own, with no share and no parent. */
export function sessionListItemFromView(session: SessionView): SessionListItem {
	return {
		id: session.id,
		title: session.title,
		ownerUserId: session.ownerUserId,
		ownerName: session.ownerUsername ?? "",
		scheduleId: session.scheduleId,
		shared: false,
		state: session.state,
		waitingKind: session.waitingKind,
		unread: false,
		updatedAt: session.updatedAt,
	};
}

/**
 * Inserts a just-created session into every loaded session list, respecting each list's scope
 *: the draft page runs before the list's SSE upsert arrives, and the reader must already see the
 * session they were sent to. A new session has the newest `updatedAt`, so the upsert's sort placement puts it
 * at the top.
 */
export function insertSessionIntoListCaches(
	queryClient: QueryClient,
	session: SessionView,
	viewer: { id: string; isAdmin: boolean },
): void {
	const item = sessionListItemFromView(session);
	for (const query of queryClient.getQueryCache().findAll({ queryKey: sessionKeys.list() })) {
		const filter = sessionListFilter(query.queryKey, { viewerId: viewer.id, isAdmin: viewer.isAdmin });
		if (!filter) continue;
		queryClient.setQueryData<SessionListData>(query.queryKey, (data) => {
			if (!data) return data;
			const pages = upsertSessionListItem(data.pages, item, filter);
			return pages === data.pages ? data : { ...data, pages };
		});
	}
}

/**
 * Marks a tree read for its owner (doc/design/webui.md "Sidebar list"): the page calls it when it opens and when its tree
 * leaves `running`; `sessionId` may be a child, because the server marks the root. The cached row is cleared
 * optimistically so the dot goes before the stream's upsert arrives; a failed call leaves the server state
 * unchanged and the next list fetch corrects the row.
 */
export function useMarkSessionRead(rootId: string | undefined) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (sessionId: string) => http.post<void>(`/sessions/${enc(sessionId)}/read`),
		meta: { toast: false },
		onMutate: () => {
			if (rootId === undefined || rootId === "") return;
			for (const query of queryClient.getQueryCache().findAll({ queryKey: sessionKeys.list() })) {
				queryClient.setQueryData<SessionListData>(query.queryKey, (data) => {
					if (!data) return data;
					const pages = markSessionListItemRead(data.pages, rootId);
					return pages === data.pages ? data : { ...data, pages };
				});
			}
		},
	});
}

export function usePatchSession(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: SessionPatch) =>
			http.patch<{ session: SessionView }>(`/sessions/${enc(id)}`, patch).then((r) => r.session),
		onSuccess: (session, patch) => {
			queryClient.setQueryData(sessionKeys.detail(id), session);
			void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
			// A rule preset change re-evaluates the waiting tasks on the server.
			if (patch.rulePreset !== undefined) invalidatePendingDecisions(queryClient);
		},
	});
}

export function useSendMessage(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ text, requestId }: { text: string; requestId: string }) =>
			http.post<{ submissionId: string }>(`/sessions/${enc(id)}/messages`, { text, requestId }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) });
			void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
		},
	});
}

/** Ask the server to summarize older history (`/compact`); the transcript's compaction divider appears once it is ready. */
export function useCompactSession(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ instructions }: { instructions?: string }) =>
			http.post<{ taskId: string; outcome: "started" | "nothing" | "failed" }>(
				`/sessions/${enc(id)}/compact`,
				instructions ? { instructions } : {},
			),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) });
		},
	});
}

export function useAbortSession(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => http.post<{ ok: true }>(`/sessions/${enc(id)}/abort`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) });
			// Stopping a session rejects the approvals its tree waits for and cancels its tasks.
			invalidatePendingDecisions(queryClient);
		},
	});
}

export interface QuotaDecision {
	decision: "approve" | "deny";
	tokens?: number;
	reason?: string;
}

/** The owner's answer to a used-up token quota on a root: add tokens, or stop the paused run. */
export function useDecideQuota(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (decision: QuotaDecision) =>
			http.post<{ ok: true; sessions: string[] }>(`/sessions/${enc(id)}/quota`, decision),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) });
			void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
			invalidatePendingDecisions(queryClient);
		},
	});
}

export function useShareSession(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { granteeType: string; granteeId: string; access: "view" | "chat" }) =>
			http.put<{ share: SessionShare }>(`/sessions/${enc(id)}/shares`, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKeys.shares(id) });
		},
	});
}

export function useUnshareSession(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (shareId: string) => http.del<{ ok: true }>(`/sessions/${enc(id)}/shares/${enc(shareId)}`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKeys.shares(id) });
		},
	});
}

/** The cache shape the SSE patch writes into (kept here so the hook and the patch agree). */
export type SessionListData = InfiniteData<CursorPage<SessionListItem>, string | null>;

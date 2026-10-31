import { type InfiniteData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { enc, http, queryString } from "@/lib/api/client";
import { useCursorInfiniteQuery } from "@/lib/api/query";
import type {
	CursorPage,
	SessionListItem,
	SessionListQuery,
	SessionPatch,
	SessionShare,
	SessionView,
} from "@/lib/api/types";
import type { EntryRecord } from "./sessionState";

/** Query keys for every session-shaped query. The list key carries its `scope`/`q`. */
export const sessionKeys = {
	all: ["sessions"] as const,
	list: () => ["sessions", "list"] as const,
	listPage: (scope: string, q: string) => ["sessions", "list", { scope, q }] as const,
	detail: (id: string) => ["sessions", "detail", id] as const,
	entries: (id: string, before: string) => ["sessions", "entries", id, before] as const,
	shares: (id: string) => ["sessions", "shares", id] as const,
};

export interface SessionListParams {
	scope: SessionListQuery["scope"];
	q: string;
}

export function useSessions({ scope = "mine", q = "" }: SessionListParams) {
	return useCursorInfiniteQuery<SessionListItem>({
		queryKey: sessionKeys.listPage(scope, q),
		fetchPage: (cursor, signal) =>
			http.get<CursorPage<SessionListItem>>(`/sessions${queryString({ scope, q, cursor })}`, { signal }),
	});
}

export function useSession(id: string | undefined) {
	return useQuery({
		queryKey: sessionKeys.detail(id ?? ""),
		enabled: id !== undefined && id !== "",
		queryFn: async ({ signal }) => {
			const result = await http.get<{ session: SessionView; shares?: SessionShare[] }>(`/sessions/${enc(id ?? "")}`, {
				signal,
			});
			return { ...result.session, shares: result.shares } as SessionView;
		},
	});
}

export interface SessionEntriesPage {
	entries: EntryRecord[];
	historyCursor: string | null;
}

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
	title?: string;
	model: SessionView["model"];
	preset: string;
	quota?: number | null;
}

export function useCreateSession() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: CreateSessionInput) =>
			http.post<{ session: SessionView }>("/sessions", input).then((r) => r.session),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
		},
	});
}

export function usePatchSession(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (patch: SessionPatch) =>
			http.patch<{ session: SessionView }>(`/sessions/${enc(id)}`, patch).then((r) => r.session),
		onSuccess: (session) => {
			queryClient.setQueryData(sessionKeys.detail(id), session);
			void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
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

export function useAbortSession(id: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => http.post<{ ok: true }>(`/sessions/${enc(id)}/abort`),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: sessionKeys.detail(id) });
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
			void queryClient.invalidateQueries({ queryKey: ["approvals"] });
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

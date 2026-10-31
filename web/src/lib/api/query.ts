import type { InfiniteData } from "@tanstack/react-query";
import {
	keepPreviousData,
	QueryClient,
	type QueryKey,
	type UseInfiniteQueryResult,
	useInfiniteQuery,
} from "@tanstack/react-query";
import { ApiError } from "./client";
import type { CursorPage } from "./types";

/**
 * Query defaults: a minute of freshness (SSE and mutations keep the cache
 * current), no retry on a 4xx (only on network/5xx errors), and no refetch on
 * window focus — a polling-heavy console should not multiply its traffic when
 * the tab regains focus.
 */
export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 60_000,
				gcTime: 10 * 60_000,
				retry: (failureCount, error) =>
					error instanceof ApiError && error.status >= 400 && error.status < 500 ? false : failureCount < 2,
				refetchOnWindowFocus: false,
			},
			mutations: { retry: false },
		},
	});
}

/** The items of every loaded page, in order. */
export function flattenCursorPages<T>(data: InfiniteData<CursorPage<T>, string | null> | undefined): T[] {
	if (!data) return [];
	return data.pages.flatMap((page) => page.items);
}

/** The cursor of the last loaded page; null means the list is complete. */
export function lastCursor<T>(data: InfiniteData<CursorPage<T>, string | null> | undefined): string | null {
	if (!data || data.pages.length === 0) return null;
	return data.pages[data.pages.length - 1]?.nextCursor ?? null;
}

export interface CursorInfiniteOptions<T> {
	queryKey: QueryKey;
	/** Fetches one page; `cursor` is undefined for the first page. */
	fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorPage<T>>;
	enabled?: boolean;
	/** Keep the previous pages visible while a changed filter is loading. */
	keepPrevious?: boolean;
	/** Poll while the list is open (a schedule's run history, for example). */
	refetchInterval?: number | false;
}

export type CursorInfiniteResult<T> = UseInfiniteQueryResult<InfiniteData<CursorPage<T>, string | null>, Error>;

/**
 * `useInfiniteQuery` with the contract's `{ items, nextCursor }` pages. The
 * first page has no cursor; the next page's cursor comes from the last one.
 */
export function useCursorInfiniteQuery<T>({
	queryKey,
	fetchPage,
	enabled = true,
	keepPrevious = true,
	refetchInterval = false,
}: CursorInfiniteOptions<T>): CursorInfiniteResult<T> {
	return useInfiniteQuery({
		queryKey,
		queryFn: ({ pageParam, signal }) => fetchPage(pageParam ?? undefined, signal),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		enabled,
		refetchInterval,
		...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
	}) as CursorInfiniteResult<T>;
}

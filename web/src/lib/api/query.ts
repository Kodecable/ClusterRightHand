import type { CursorPage } from "@crh/api";
import type { InfiniteData } from "@tanstack/react-query";
import {
	keepPreviousData,
	MutationCache,
	QueryClient,
	type QueryKey,
	type UseInfiniteQueryResult,
	useInfiniteQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "./client";

/**
 * Query defaults: a minute of freshness (SSE and mutations keep the cache
 * current), no retry on a 4xx (only on network/5xx errors), and no refetch on
 * window focus — a polling-heavy console should not multiply its traffic when
 * the tab regains focus.
 *
 * A failed mutation reports the server's message as a toast by default; a
 * mutation whose error is shown inline (a form's error line, a test button)
 * opts out with `meta: { toast: false }`.
 */
export function createQueryClient(): QueryClient {
	return new QueryClient({
		mutationCache: new MutationCache({
			onError: (error, _variables, _context, mutation) => {
				if (mutation.meta?.toast === false) return;
				toast.error(error.message);
			},
		}),
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
 * Start a cursor page request before the component that shows it mounts; the
 * later `useInfiniteQuery` with the same key joins the request instead of
 * issuing a second one (doc/design/webui.md "Performance targets": the first screen must not
 * wait for the list request to start after the layout chunk has rendered).
 */
export function prefetchCursorInfiniteQuery<T>(
	queryClient: QueryClient,
	{ queryKey, fetchPage }: Pick<CursorInfiniteOptions<T>, "queryKey" | "fetchPage">,
): Promise<void> {
	return queryClient.prefetchInfiniteQuery({
		queryKey,
		queryFn: ({ pageParam, signal }) => fetchPage((pageParam as string | null) ?? undefined, signal),
		initialPageParam: null as string | null,
		getNextPageParam: (page: CursorPage<T>) => page.nextCursor,
	});
}

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

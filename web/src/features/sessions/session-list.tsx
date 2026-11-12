import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { PlusIcon, SearchIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ListSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { WarningBanner } from "@/components/warning-banner";
import { useAuth } from "@/features/auth/session";
import { useModels } from "@/features/settings/api";
import { flattenCursorPages, lastCursor } from "@/lib/api/query";
import { linkClass } from "@/lib/utils";
import { useSessions } from "./api";
import { groupSessionRows, type SessionGroupKey } from "./session-groups";
import { SessionListItemRow } from "./session-list-item";
import { openSessionSearch } from "./session-search-dialog";
import { useSessionListStream } from "./use-session-list-stream";

/** Whether the platform's shortcut hint is ⌘K; every other platform uses Ctrl K. */
function isMac(): boolean {
	return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

/**
 * The second column of the Sessions route (doc/design/webui.md "Sidebar list"): the
 * search button, a full-width "New session" button, then a virtua list with
 * cursor pages and the live patch from `GET /api/sessions/stream`. The list
 * shows the roots the caller can see: their own and the ones shared with them.
 * Rows are grouped by `updatedAt` (Today, Yesterday, Within 7 days, Within 30
 * days, then a month): the headers are rows of the same virtualised list, and
 * the arrow keys move between items while skipping them.
 */
export function SessionList({ selectedId }: { selectedId?: string }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const location = useLocation();
	const auth = useAuth();
	const isAdmin = auth.user?.kind === "admin";
	const [activeIndex, setActiveIndex] = useState(0);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const virtualizer = useRef<VirtualizerHandle | null>(null);

	const models = useModels();
	const noModels = models.data !== undefined && models.data.length === 0;
	// "New session" opens the draft page and calls no API; pressing it on the draft does nothing.
	const draft = location.pathname === "/sessions/new";
	const openDraft = () => {
		if (draft) return;
		void navigate({ to: "/sessions/new" });
	};
	const sessions = useSessions();
	const items = useMemo(() => flattenCursorPages(sessions.data), [sessions.data]);
	const hasMore = lastCursor(sessions.data) !== null;
	// A minute is enough for the day boundary: a header only changes when the clock crosses midnight.
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 60_000);
		return () => clearInterval(timer);
	}, []);
	const rows = useMemo(() => groupSessionRows(items, now), [items, now]);
	const itemIndex = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);
	// The row index of each item, for the roving focus and scrolling: header rows sit between them.
	const itemRows = useMemo(() => {
		const indexes: number[] = [];
		rows.forEach((row, index) => {
			if (row.item !== undefined) indexes.push(index);
		});
		return indexes;
	}, [rows]);

	useSessionListStream({
		viewer: { id: auth.user?.id ?? "", isAdmin },
		enabled: auth.user !== null,
	});

	// Keep the active row on the selected session when arriving by a link.
	useEffect(() => {
		if (selectedId === undefined) return;
		const index = items.findIndex((item) => item.id === selectedId);
		if (index >= 0) setActiveIndex(index);
	}, [selectedId, items]);

	const loadMore = () => {
		if (!hasMore || sessions.isFetchingNextPage) return;
		void sessions.fetchNextPage();
	};

	const onScroll = () => {
		const element = scrollRef.current;
		if (!element) return;
		if (element.scrollTop + element.clientHeight >= element.scrollHeight - 240) loadMore();
	};

	const focusRow = (index: number) => {
		virtualizer.current?.scrollToIndex(itemRows[index] ?? index, { align: "nearest" });
		requestAnimationFrame(() => {
			const row = items[index];
			if (!row) return;
			const element = scrollRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(row.id)}"]`);
			element?.focus();
		});
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (items.length === 0) return;
		const current = activeIndex;
		let next: number | null = null;
		if (event.key === "ArrowDown") next = Math.min(items.length - 1, current + 1);
		else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = items.length - 1;
		else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
			// Enter activates the highlighted row. preventDefault also stops a
			// focused row link from navigating to a stale selection when the
			// asynchronous focus move has not caught up with an arrow press yet.
			const item = items[current];
			if (item) {
				event.preventDefault();
				void navigate({ to: "/sessions/$sessionId", params: { sessionId: item.id } });
			}
			return;
		} else {
			return;
		}
		event.preventDefault();
		setActiveIndex(next);
		focusRow(next);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="session-list">
			<div className="grid shrink-0 gap-2 p-2">
				<button
					type="button"
					data-testid="session-search-open"
					data-slot="session-search-button"
					aria-label={t`Search sessions`}
					aria-keyshortcuts="Control+K Meta+K"
					onClick={() => openSessionSearch()}
					className="flex h-7 w-full items-center gap-2 rounded-lg border border-input bg-transparent px-2 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
				>
					<SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate">
						<Trans>Search sessions…</Trans>
					</span>
					<kbd className="pointer-events-none shrink-0 rounded border bg-muted px-1 py-0.5 font-sans text-[10px] leading-none font-medium text-muted-foreground">
						{isMac() ? "⌘K" : "Ctrl K"}
					</kbd>
				</button>
				<Button
					type="button"
					size="sm"
					className="w-full"
					data-testid="new-session-button"
					disabled={noModels}
					title={noModels ? t`No model is configured` : undefined}
					onClick={openDraft}
				>
					<PlusIcon />
					<Trans>New session</Trans>
				</Button>

				{noModels && (
					<WarningBanner data-testid="no-models-hint">
						<Trans>No models are configured, so sessions cannot start.</Trans>{" "}
						{isAdmin ? (
							<Link to="/settings/models" className={linkClass}>
								<Trans>Configure a model provider</Trans>
							</Link>
						) : (
							<Trans>Ask an administrator to configure one.</Trans>
						)}
					</WarningBanner>
				)}
			</div>

			<div
				ref={scrollRef}
				role="listbox"
				aria-label={t`Sessions`}
				tabIndex={0}
				onScroll={onScroll}
				onKeyDown={onKeyDown}
				className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
				data-testid="session-list-scroller"
			>
				{sessions.isPending && items.length === 0 && (
					<div className="p-3">
						<ListSkeleton rows={6} />
					</div>
				)}
				{sessions.isError && items.length === 0 && (
					<ErrorState error={sessions.error} retry={() => void sessions.refetch()} className="m-3" compact />
				)}
				{!sessions.isPending && !sessions.isError && items.length === 0 && (
					<EmptyState
						className="m-3 py-8"
						title={<Trans>No sessions yet</Trans>}
						description={<Trans>Start one, or wait for a scheduled run.</Trans>}
					/>
				)}
				{rows.length > 0 && (
					<Virtualizer ref={virtualizer} data={rows}>
						{(row) =>
							row.item !== undefined ? (
								<SessionListItemRow
									key={row.key}
									item={row.item}
									selected={row.item.id === selectedId}
									tabIndex={itemIndex.get(row.item.id) === activeIndex ? 0 : -1}
								/>
							) : (
								<SessionGroupHeader key={row.key} group={row.header as SessionGroupKey} />
							)
						}
					</Virtualizer>
				)}
				{sessions.isFetchingNextPage && (
					<p className="px-3 py-2 text-center text-xs text-muted-foreground" role="status">
						<Trans>Loading more sessions…</Trans>
					</p>
				)}
			</div>
		</div>
	);
}

/** One date group's heading, inside the virtualised list so it scrolls with its items. */
function SessionGroupHeader({ group }: { group: SessionGroupKey }) {
	const { t } = useLingui();
	return (
		<div
			data-testid="session-group-header"
			className="flex h-7 items-center px-2 text-[11px] font-medium text-muted-foreground"
		>
			{group.kind === "today"
				? t`Today`
				: group.kind === "yesterday"
					? t`Yesterday`
					: group.kind === "week"
						? t`Within 7 days`
						: group.kind === "month30"
							? t`Within 30 days`
							: group.month}
		</div>
	);
}

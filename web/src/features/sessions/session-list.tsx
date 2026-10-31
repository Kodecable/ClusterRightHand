import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, SearchIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { ListSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/session";
import { useModels } from "@/features/settings/api";
import { useDebouncedValue } from "@/hooks/use-debounced";
import { flattenCursorPages, lastCursor } from "@/lib/api/query";
import type { SessionListScope } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { useSessions } from "./api";
import { NewSessionDialog } from "./new-session-dialog";
import { SessionListItemRow } from "./session-list-item";
import { useSessionListStream } from "./use-session-list-stream";

const ROW_HEIGHT = 64;

/**
 * The second column of the Sessions route (doc/webui.md "侧边列表"): scope
 * tabs, a debounced server-side search, a virtua list with cursor pages, and
 * the live patch from `GET /api/sessions/stream`. Up/Down/Home/End move the
 * active row, Enter opens it.
 */
export function SessionList({ selectedId }: { selectedId?: string }) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const auth = useAuth();
	const isAdmin = auth.user?.kind === "admin";
	const [scope, setScope] = useState<SessionListScope>("mine");
	const [search, setSearch] = useState("");
	const q = useDebouncedValue(search.trim(), 250);
	const [creating, setCreating] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const virtualizer = useRef<VirtualizerHandle | null>(null);

	const models = useModels();
	const noModels = models.data !== undefined && models.data.length === 0;
	const sessions = useSessions({ scope, q });
	const items = useMemo(() => flattenCursorPages(sessions.data), [sessions.data]);
	const hasMore = lastCursor(sessions.data) !== null;

	useSessionListStream({
		viewer: { id: auth.user?.id ?? "", isAdmin },
		enabled: auth.user !== null,
	});

	// A changed filter is a new list: start at the top and drop the old selection index.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the filter changes
	useEffect(() => {
		setActiveIndex(0);
		if (scrollRef.current) scrollRef.current.scrollTop = 0;
	}, [scope, q]);

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
		virtualizer.current?.scrollToIndex(index, { align: "nearest" });
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

	const scopes: { value: SessionListScope; label: string }[] = [
		{ value: "mine", label: t`Mine` },
		{ value: "shared", label: t`Shared` },
		...(isAdmin ? [{ value: "all" as const, label: t`All` }] : []),
	];

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="session-list">
			<div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
				<h2 className="text-sm font-semibold">
					<Trans>Sessions</Trans>
				</h2>
				<Button
					type="button"
					size="sm"
					className="ml-auto"
					data-testid="new-session-button"
					disabled={noModels}
					title={noModels ? t`No model is configured` : undefined}
					onClick={() => setCreating(true)}
				>
					<PlusIcon />
					<Trans>New</Trans>
				</Button>
			</div>

			<div className="grid shrink-0 gap-2 border-b px-3 py-2">
				<div className="relative block">
					<label className="sr-only" htmlFor="session-search">
						<Trans>Search sessions</Trans>
					</label>
					<SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						id="session-search"
						type="search"
						value={search}
						placeholder={t`Search sessions`}
						data-testid="session-search"
						className="h-7 pl-7 text-sm"
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
				<fieldset className="inline-flex rounded-md bg-muted p-0.5 text-xs">
					<legend className="sr-only">
						<Trans>Scope</Trans>
					</legend>
					{scopes.map((option) => (
						<Button
							key={option.value}
							type="button"
							variant={scope === option.value ? "secondary" : "ghost"}
							size="xs"
							aria-pressed={scope === option.value}
							data-testid={`scope-${option.value}`}
							className="flex-1"
							onClick={() => setScope(option.value)}
						>
							{option.label}
						</Button>
					))}
				</fieldset>
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
						className="m-3 border-0 py-8"
						title={q === "" ? <Trans>No sessions yet</Trans> : <Trans>No session matches</Trans>}
						description={
							q === "" ? <Trans>Start one, or wait for a scheduled run.</Trans> : <Trans>Try a different search.</Trans>
						}
						action={
							q === "" ? (
								<Button type="button" size="sm" disabled={noModels} onClick={() => setCreating(true)}>
									<PlusIcon />
									<Trans>New session</Trans>
								</Button>
							) : undefined
						}
					/>
				)}
				{items.length > 0 && (
					<Virtualizer ref={virtualizer} data={items} itemSize={ROW_HEIGHT} bufferSize={ROW_HEIGHT * 4}>
						{(item, index) => (
							<SessionListItemRow
								key={item.id}
								item={item}
								selected={item.id === selectedId}
								tabIndex={index === activeIndex ? 0 : -1}
							/>
						)}
					</Virtualizer>
				)}
				{sessions.isFetchingNextPage && (
					<p className="px-3 py-2 text-center text-xs text-muted-foreground" role="status">
						<Trans>Loading more sessions…</Trans>
					</p>
				)}
				{!hasMore && items.length > 0 && (
					<p className={cn("px-3 py-2 text-center text-xs text-muted-foreground")}>
						<Plural value={items.length} one="# session" other="# sessions" />
					</p>
				)}
			</div>

			<NewSessionDialog open={creating} onOpenChange={setCreating} />
		</div>
	);
}

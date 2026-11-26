import { useLingui } from "@lingui/react/macro";
import { LoaderCircleIcon } from "lucide-react";
import { type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useSessionOutline } from "./api";
import { buildTurnRailItems, outlineTurnsFromPages, type RailUserItem, type TurnRailItem } from "./turn-rail-items";

/** The rail only appears on a transcript at least this wide (doc/design/webui.md "Turn rail"). */
export const TURN_RAIL_MIN_WIDTH = 960;
const MIN_ITEMS = 2;
const LOAD_MORE_TOP = 40;
const EDGE_FADE = 12;

interface Preview {
	entryId: string;
	/** The mark's centre inside the rail box, in pixels. */
	center: number;
}

/** The preview line of one mark: the text with a trailing ellipsis when the outline cut it. */
function previewText(item: TurnRailItem): string {
	return item.truncated ? `${item.text}…` : item.text;
}

/**
 * The turn rail (doc/design/webui.md "Turn rail"): one mark per user message, oldest at the top, over the
 * transcript's right edge. Marks of turns the transcript has not loaded yet come from `GET
 * /api/sessions/:id/outline`, paged on demand from the history cursor; loaded turns come from the transcript
 * itself. A mark jumps through the same history-loading flow as a search hit, with `align: "start"`.
 */
export function TurnRail({
	sessionId,
	historyCursor,
	loadedItems,
	activeEntryId,
	pendingEntryId,
	onJumpToEntry,
}: {
	sessionId: string;
	/** The transcript's history cursor when the rail first opened; null means all history is loaded. */
	historyCursor: string | null;
	/** The transcript's loaded user items, in transcript order. */
	loadedItems: readonly RailUserItem[];
	/** The entry of the user turn at the top third of the transcript, or null before any row exists. */
	activeEntryId: string | null;
	/** The rail jump still loading history: its mark pulses until the entry is in the transcript. */
	pendingEntryId?: string;
	onJumpToEntry: (entryId: string) => void;
}) {
	const { t } = useLingui();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const previewRef = useRef<HTMLDivElement | null>(null);
	const [hovering, setHovering] = useState(false);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [edges, setEdges] = useState({ fadeTop: false, fadeBottom: false });
	// The boundary between the loaded transcript and the outline never moves once the rail is open: older
	// pages only make the loaded side grow past it. A session switch remounts the transcript, but the guard
	// keeps a reused rail from carrying the previous session's cursor over.
	const [boundary, setBoundary] = useState<{ sessionId: string; start: string | null }>({
		sessionId,
		start: historyCursor,
	});
	if (boundary.sessionId !== sessionId) setBoundary({ sessionId, start: historyCursor });
	const start = boundary.sessionId === sessionId ? boundary.start : historyCursor;

	// The rail is mounted only on a wide transcript, so enabling this with a start is "while the rail is
	// shown"; a null start means the snapshot is complete and no outline request is ever made.
	const outline = useSessionOutline(sessionId, start, start !== null);
	const items = useMemo(
		() => buildTurnRailItems(outlineTurnsFromPages(outline.data?.pages), loadedItems),
		[outline.data, loadedItems],
	);
	const hasMore = outline.hasNextPage || outline.isFetching;
	const visible = items.length >= MIN_ITEMS || hasMore;
	const previewItem = preview === null ? undefined : items.find((item) => item.entryId === preview.entryId);

	const updateEdges = useCallback(() => {
		const element = scrollerRef.current;
		if (element === null) return;
		const fadeTop = element.scrollTop > 1;
		const fadeBottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
		setEdges((current) =>
			current.fadeTop === fadeTop && current.fadeBottom === fadeBottom ? current : { fadeTop, fadeBottom },
		);
	}, []);

	const showPreview = useCallback((entryId: string, element: HTMLElement) => {
		const root = rootRef.current;
		if (root === null) return;
		const rootRect = root.getBoundingClientRect();
		const markRect = element.getBoundingClientRect();
		const center = markRect.top + markRect.height / 2 - rootRect.top;
		setPreview((current) =>
			current !== null && current.entryId === entryId && Math.abs(current.center - center) < 0.5
				? current
				: { entryId, center },
		);
	}, []);

	// Keep the preview inside the rail box: a mark near an end would otherwise put it half outside.
	useLayoutEffect(() => {
		if (preview === null) return;
		const root = rootRef.current;
		const panel = previewRef.current;
		if (root === null || panel === null) return;
		const half = panel.offsetHeight / 2;
		const minimum = half + 4;
		const maximum = Math.max(minimum, root.clientHeight - half - 4);
		const center = Math.min(Math.max(preview.center, minimum), maximum);
		if (Math.abs(center - preview.center) < 0.5) return;
		setPreview((current) =>
			current !== null && current.entryId === preview.entryId ? { ...current, center } : current,
		);
	}, [preview]);

	// A mark of the active turn or of a jump in flight is scrolled into the rail's own band. The page and the
	// transcript never move: only the rail's scrollTop changes. New marks change where the active one sits.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new mark list must bring the active mark back into the band
	useEffect(() => {
		if (hovering || activeEntryId === null) return;
		const scroller = scrollerRef.current;
		if (scroller === null) return;
		const mark = [...scroller.querySelectorAll<HTMLElement>("[data-rail-entry]")].find(
			(element) => element.dataset.railEntry === activeEntryId,
		);
		if (mark === undefined) return;
		const viewport = scroller.getBoundingClientRect();
		const rect = mark.getBoundingClientRect();
		const padding = 12;
		if (rect.top < viewport.top + padding) scroller.scrollTop -= viewport.top + padding - rect.top;
		else if (rect.bottom > viewport.bottom - padding) scroller.scrollTop += rect.bottom - (viewport.bottom - padding);
	}, [activeEntryId, hovering, items.length]);

	// An older outline page lands above the marks the reader is looking at: keep them where they were by
	// moving the rail's own scroll position down by the height the new marks added.
	const pageCount = outline.data?.pages.length ?? 0;
	const anchor = useRef({ pages: 0, height: 0 });
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		if (scroller === null) return;
		const previous = anchor.current;
		if (pageCount > previous.pages && previous.pages > 0) {
			scroller.scrollTop += scroller.scrollHeight - previous.height;
		}
		anchor.current = { pages: pageCount, height: scroller.scrollHeight };
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new mark or loader changes the scroller height, so its smooth-scroll edges must be remeasured
	useLayoutEffect(() => {
		updateEdges();
	}, [updateEdges, items.length, hasMore]);

	useEffect(() => {
		if (!visible) return;
		const element = scrollerRef.current;
		if (element === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => updateEdges());
		observer.observe(element);
		return () => observer.disconnect();
	}, [updateEdges, visible]);

	useEffect(() => {
		if (preview !== null && previewItem === undefined) setPreview(null);
	}, [preview, previewItem]);

	const onRailScroll = (event: UIEvent<HTMLDivElement>) => {
		const element = event.currentTarget;
		updateEdges();
		if (preview !== null) setPreview(null);
		if (element.scrollTop <= LOAD_MORE_TOP && outline.hasNextPage && !outline.isFetchingNextPage) {
			void outline.fetchNextPage();
		}
	};

	if (!visible) return null;

	const maskImage = `linear-gradient(to bottom, ${edges.fadeTop ? "transparent" : "black"} 0, black ${
		edges.fadeTop ? EDGE_FADE : 0
	}px, black calc(100% - ${edges.fadeBottom ? EDGE_FADE : 0}px), ${edges.fadeBottom ? "transparent" : "black"} 100%)`;

	const label = (item: TurnRailItem) => {
		const text = item.text === "" ? t`(no text)` : item.text;
		return t`Go to message: ${text}`;
	};

	return (
		<div
			ref={rootRef}
			data-testid="turn-rail"
			className="absolute top-1/2 right-2 z-10 flex w-8 -translate-y-1/2 flex-col"
			style={{ maxHeight: "min(calc(100% - 64px), 420px)" }}
			onPointerEnter={() => setHovering(true)}
			onPointerLeave={() => {
				setHovering(false);
				setPreview(null);
			}}
		>
			{preview !== null && previewItem !== undefined && (
				<div
					ref={previewRef}
					data-testid="turn-rail-preview"
					className="pointer-events-none absolute right-full z-20 mr-2 w-max max-w-[300px] -translate-y-1/2 rounded-lg bg-popover px-2.5 py-1.5 text-xs break-words text-popover-foreground shadow-md"
					style={{ top: preview.center }}
				>
					{previewItem.text === "" ? (
						<span className="text-muted-foreground italic">{t`(no text)`}</span>
					) : (
						<span className="line-clamp-2">{previewText(previewItem)}</span>
					)}
				</div>
			)}
			<div
				ref={scrollerRef}
				data-testid="turn-rail-scroller"
				onScroll={onRailScroll}
				className="min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				style={{ maskImage, WebkitMaskImage: maskImage }}
			>
				{hasMore && (
					<div
						data-testid="turn-rail-more"
						aria-hidden="true"
						className="flex h-2.5 items-center justify-end pr-1 text-muted-foreground"
					>
						{outline.isFetching ? (
							<LoaderCircleIcon className="size-2.5 animate-spin motion-reduce:animate-none" />
						) : (
							<span className="flex items-center gap-0.5">
								<span className="size-0.5 rounded-full bg-muted-foreground/60" />
								<span className="size-0.5 rounded-full bg-muted-foreground/60" />
								<span className="size-0.5 rounded-full bg-muted-foreground/60" />
							</span>
						)}
					</div>
				)}
				<nav aria-label={t`Messages`} className="flex flex-col">
					{items.map((item) => {
						const active = item.entryId === activeEntryId;
						const previewed = preview?.entryId === item.entryId;
						const busy = item.entryId === pendingEntryId;
						return (
							<button
								key={item.entryId}
								type="button"
								data-rail-entry={item.entryId}
								data-loaded={item.loaded ? "true" : "false"}
								aria-label={label(item)}
								aria-current={active ? "true" : undefined}
								onClick={() => onJumpToEntry(item.entryId)}
								onPointerMove={(event) => showPreview(item.entryId, event.currentTarget)}
								onFocus={(event) => showPreview(item.entryId, event.currentTarget)}
								onBlur={() => setPreview(null)}
								className={cn(
									"group flex h-2.5 w-full items-center justify-end rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
									busy && "animate-pulse motion-reduce:animate-none",
								)}
							>
								<span
									className={cn(
										"h-0.5 w-5 origin-right rounded-full bg-border transition-[transform,background-color,opacity] duration-150 motion-reduce:transition-none",
										item.loaded ? "scale-x-[0.6]" : "scale-x-[0.4] opacity-60",
										!active && "group-hover:scale-x-90 group-hover:bg-muted-foreground group-hover:opacity-100",
										previewed && "scale-x-90 bg-muted-foreground opacity-100",
										!active && "group-focus-visible:scale-x-100 group-focus-visible:bg-ring",
										active && "scale-x-100 bg-foreground opacity-100",
									)}
								/>
							</button>
						);
					})}
				</nav>
			</div>
		</div>
	);
}

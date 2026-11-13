import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowDownIcon, LoaderCircleIcon } from "lucide-react";
import { type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import { Button } from "@/components/ui/button";
import { TurnDeliveries } from "./deliveries";
import type { DeliveryDetails } from "./tool-details";
import type { TranscriptItem } from "./transcript-items";
import { TranscriptRow, TurnSummaryRow } from "./transcript-row";
import type { TranscriptStreams } from "./transcript-streams";
import { buildTranscriptTurns } from "./turns";

const END_THRESHOLD = 80;
const SETTLE_MS = 2_000;
const ANCHOR_MS = 400;
const LOAD_DEBOUNCE_MS = 120;
/** How long a jumped-to entry keeps its highlight before it fades (doc/design/webui.md "Jumping to a message"). */
const HIGHLIGHT_MS = 2_000;

interface Anchor {
	id: string;
	top: number;
}

interface PrependAnchor extends Anchor {
	/** The transcript's first item when the page was requested; the anchor is applied once this changes. */
	firstId: string;
}

type TranscriptDisplayRow =
	| { kind: "item"; key: string; item: TranscriptItem }
	| {
			kind: "summary";
			key: string;
			turnKey: string;
			durationMs: number | undefined;
			open: boolean;
	  }
	| { kind: "deliveries"; key: string; deliveries: DeliveryDetails[] };

/**
 * The session transcript (doc/design/webui.md "Message view"): a virtua list with `shift`
 * for prepends, bottom following that stops the moment the reader scrolls up,
 * a jump-to-latest button, and explicit anchor corrections.
 *
 * Why explicit correction: `shift` keeps the distance from the end, so a
 * freshly prepended page that is still measured from estimated row heights
 * moves the reading anchor by a few dozen pixels. The component records the
 * first visible row and its viewport offset, then re-aligns until
 * measurements settle (≤ 2 px by design).
 */
export function Transcript({
	items,
	streams,
	ready,
	sessionActive,
	hasOlder,
	loadingOlder,
	onLoadOlder,
	empty,
	focusEntry,
}: {
	items: TranscriptItem[];
	streams: TranscriptStreams;
	ready: boolean;
	/** Whether the session is running or awaiting: a call without a result cannot return once it is idle. */
	sessionActive: boolean;
	hasOlder: boolean;
	loadingOlder: boolean;
	onLoadOlder: () => void;
	empty?: React.ReactNode;
	/** The entry a search hit asked to jump to; once its rows exist the list centers and marks it. */
	focusEntry?: string;
}) {
	const { t } = useLingui();
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const virtualizer = useRef<VirtualizerHandle | null>(null);
	const [atBottom, setAtBottom] = useState(true);
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const handledFocus = useRef<string | null>(null);
	const atBottomRef = useRef(true);
	const followingRef = useRef(true);
	/** Set only by a real wheel/key gesture: a scroll event alone must not cancel the settle loop. */
	const userGestureRef = useRef(false);
	const initialScrollDone = useRef(false);
	const prevFirstId = useRef<string | null>(null);
	const prevLength = useRef(0);
	const settleToken = useRef(0);
	const programmaticAt = useRef(0);
	const prependAnchor = useRef<PrependAnchor | null>(null);
	const realignToken = useRef(0);
	const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const firstId = items[0]?.key ?? "";

	const publishAtBottom = useCallback((value: boolean) => {
		if (atBottomRef.current === value) return;
		atBottomRef.current = value;
		setAtBottom(value);
	}, []);

	const measureAtBottom = useCallback(() => {
		const element = scrollRef.current;
		if (!element) return;
		publishAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight <= END_THRESHOLD);
	}, [publishAtBottom]);

	const pinToEnd = useCallback(() => {
		const element = scrollRef.current;
		if (!element) return;
		if (element.scrollHeight - element.scrollTop - element.clientHeight > 1) {
			programmaticAt.current = performance.now();
			element.scrollTop = element.scrollHeight;
		}
	}, []);

	/**
	 * Put the viewport at the end repeatedly while the virtualizer discovers real
	 * row heights; the first paint uses estimates, so a single write is not
	 * enough. A wheel / key gesture cancels the loop through `followingRef`.
	 */
	const settleToEnd = useCallback(() => {
		const token = ++settleToken.current;
		followingRef.current = true;
		userGestureRef.current = false;
		const startedAt = performance.now();
		let lastHeight = -1;
		let stableFrames = 0;
		const run = () => {
			if (settleToken.current !== token || userGestureRef.current) return;
			pinToEnd();
			const element = scrollRef.current;
			if (element === null) return;
			const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
			// The virtualizer keeps replacing estimated row heights with measured
			// ones for a while; only stop after the content stopped moving while at
			// the end, not merely at the first moment the distances match.
			if (distance <= 1 && element.scrollHeight === lastHeight) stableFrames += 1;
			else stableFrames = 0;
			lastHeight = element.scrollHeight;
			if ((distance > 1 || stableFrames < 8) && performance.now() - startedAt < SETTLE_MS) {
				requestAnimationFrame(run);
				return;
			}
			measureAtBottom();
		};
		requestAnimationFrame(run);
	}, [measureAtBottom, pinToEnd]);

	const visibleAnchor = useCallback((): Anchor | null => {
		const element = scrollRef.current;
		if (!element) return null;
		const top = element.getBoundingClientRect().top;
		const rows = element.querySelectorAll<HTMLElement>('[data-testid="message"]');
		for (const row of rows) {
			if (row.getBoundingClientRect().bottom <= top + 1) continue;
			const id = row.getAttribute("data-message-id");
			return id === null ? null : { id, top: row.getBoundingClientRect().top };
		}
		return null;
	}, []);

	/** Records the reading anchor in the DOM too, so the e2e test measures the same row. */
	const capturePrependAnchor = useCallback(() => {
		const element = scrollRef.current;
		const anchor = visibleAnchor();
		if (!element || !anchor || firstId === "") return;
		const recorded = { ...anchor, firstId };
		prependAnchor.current = recorded;
		element.dataset.prependAnchorId = recorded.id;
		element.dataset.prependAnchorTop = String(recorded.top);
	}, [firstId, visibleAnchor]);

	const realign = useCallback((anchor: Anchor, durationMs: number) => {
		const token = ++realignToken.current;
		const startedAt = performance.now();
		const tick = () => {
			if (realignToken.current !== token) return;
			const element = scrollRef.current;
			const row = element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
			if (element && row) {
				const delta = row.getBoundingClientRect().top - anchor.top;
				if (Math.abs(delta) > 0.5) element.scrollTop += delta;
			}
			if (performance.now() - startedAt < durationMs) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	}, []);

	const requestOlder = useCallback(() => {
		if (!hasOlder || loadingOlder || loadTimer.current !== null) return;
		loadTimer.current = setTimeout(() => {
			loadTimer.current = null;
			requestAnimationFrame(() => {
				capturePrependAnchor();
				onLoadOlder();
			});
		}, LOAD_DEBOUNCE_MS);
	}, [capturePrependAnchor, hasOlder, loadingOlder, onLoadOlder]);

	// Opening the transcript (or the first messages of a new session) lands at the bottom.
	useLayoutEffect(() => {
		if (!ready || items.length === 0) return;
		if (initialScrollDone.current) return;
		initialScrollDone.current = true;
		settleToEnd();
	}, [items.length, ready, settleToEnd]);

	// While following, a growing stream keeps the view pinned. The store
	// notifies once per animation frame, not once per token.
	useEffect(() => {
		return streams.subscribe(() => {
			if (followingRef.current) pinToEnd();
		});
	}, [pinToEnd, streams]);

	// A new message appended at the bottom is pinned too (a streaming block is
	// already published at its first delta).
	useLayoutEffect(() => {
		const appended = items.length > prevLength.current && prevFirstId.current !== null;
		prevLength.current = items.length;
		const nextFirstId = items[0]?.key ?? null;
		const prepended = prevFirstId.current !== null && nextFirstId !== prevFirstId.current && appended;
		prevFirstId.current = nextFirstId;
		if (prepended) return;
		if (followingRef.current && appended) pinToEnd();
	}, [items.length, items, pinToEnd]);

	// A prepended history page: re-align the recorded anchor until the new rows
	// have been measured, then let go. The anchor belongs to the page that was
	// requested in front of `anchor.firstId`; a streaming update would only add
	// rows at the bottom, so it must not consume the anchor before that page
	// arrives.
	useLayoutEffect(() => {
		const anchor = prependAnchor.current;
		if (anchor === null) return;
		if (firstId === "") {
			prependAnchor.current = null;
			return;
		}
		if (firstId === anchor.firstId) return;
		prependAnchor.current = null;
		realign(anchor, ANCHOR_MS);
	}, [firstId, realign]);

	useEffect(() => {
		const root = scrollRef.current;
		const sentinel = sentinelRef.current;
		if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) requestOlder();
			},
			{ root, rootMargin: "240px 0px 0px 0px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [requestOlder]);

	// An upward gesture is intent to stop following immediately, before the
	// asynchronous scroll event arrives.
	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			if (event.deltaY < 0) {
				userGestureRef.current = true;
				followingRef.current = false;
				publishAtBottom(false);
			}
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
				userGestureRef.current = true;
				followingRef.current = false;
				publishAtBottom(false);
			}
		};
		element.addEventListener("wheel", onWheel, { passive: true });
		element.addEventListener("keydown", onKeyDown);
		return () => {
			element.removeEventListener("wheel", onWheel);
			element.removeEventListener("keydown", onKeyDown);
		};
	}, [publishAtBottom]);

	useEffect(() => {
		return () => {
			if (loadTimer.current !== null) clearTimeout(loadTimer.current);
		};
	}, []);

	const onScroll = (event: UIEvent<HTMLDivElement>) => {
		const element = event.currentTarget;
		if (element.scrollTop < 360) requestOlder();
		const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= END_THRESHOLD;
		const recentProgrammatic = performance.now() - programmaticAt.current < 150;
		if (!recentProgrammatic) followingRef.current = atEnd;
		publishAtBottom(atEnd);
	};

	const [openTurns, setOpenTurns] = useState<ReadonlySet<string>>(() => new Set());
	// A live compacting row is always rendered after the last turn (doc/design/webui.md "Message rendering"); keeping it out
	// of the turn builder means it can neither decide a turn's final answer nor hide a folded turn's rows.
	const turns = useMemo(
		() =>
			buildTranscriptTurns(
				items.filter((item) => item.kind !== "compacting"),
				sessionActive,
			),
		[items, sessionActive],
	);
	const rows = useMemo(() => {
		const display: TranscriptDisplayRow[] = [];
		for (const turn of turns) {
			if (turn.user !== undefined) display.push({ kind: "item", key: turn.user.key, item: turn.user });
			if (turn.foldable) {
				const open = openTurns.has(turn.key);
				display.push({
					kind: "summary",
					key: `summary:${turn.key}`,
					turnKey: turn.key,
					durationMs: turn.durationMs,
					open,
				});
				if (open) {
					for (const item of turn.process) display.push({ kind: "item", key: item.key, item });
				} else {
					// A closed turn still lists its compaction notes (doc/design/webui.md "Message rendering"):
					// they are never hidden by the fold and stay in commit order before the final answer.
					for (const item of turn.process) {
						if (item.kind === "compaction") display.push({ kind: "item", key: item.key, item });
					}
				}
				if (turn.final !== undefined) display.push({ kind: "item", key: turn.final.key, item: turn.final });
				// Compaction notes committed after the final answer always follow it, whether
				// the turn is open or closed, so the transcript keeps commit order (doc/design/webui.md "Message rendering").
				for (const item of turn.after) display.push({ kind: "item", key: item.key, item });
			} else {
				for (const item of turn.body) display.push({ kind: "item", key: item.key, item });
			}
			// The turn's delivered files follow everything it shows, and stay out of its fold.
			if (turn.ended && turn.deliveries.length > 0) {
				display.push({ kind: "deliveries", key: `deliveries:${turn.key}`, deliveries: turn.deliveries });
			}
		}
		for (const item of items) if (item.kind === "compacting") display.push({ kind: "item", key: item.key, item });
		return display;
	}, [openTurns, turns, items]);
	const toggleTurn = useCallback((key: string) => {
		setOpenTurns((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	const previousFirst = prevFirstId.current;
	const shift = previousFirst !== null && firstId !== "" && firstId !== previousFirst;

	// Jump-to-message (doc/design/webui.md "Jumping to a message"): the target rows exist once the entry is
	// loaded. Center the first of them, stop following the end, then fade the highlight.
	const focusToken = useRef(0);
	useLayoutEffect(() => {
		if (focusEntry === undefined || handledFocus.current === focusEntry) return;
		const index = rows.findIndex((row) => row.kind === "item" && row.item.entryId === focusEntry);
		if (index === -1) {
			// Process rows of a completed turn are folded behind its summary; open that
			// turn so a hit on a thinking/tool entry has a row to scroll to.
			const folded = turns.find(
				(turn) =>
					turn.foldable &&
					!openTurns.has(turn.key) &&
					[turn.user, turn.final, ...turn.process, ...turn.after].some((item) => item?.entryId === focusEntry),
			);
			if (folded !== undefined) {
				setOpenTurns((previous) => {
					const next = new Set(previous);
					next.add(folded.key);
					return next;
				});
			}
			return;
		}
		handledFocus.current = focusEntry;
		// Stop the initial "settle to the end" loop, otherwise it would keep pinning the
		// view to the bottom while the jump is trying to center the target row.
		settleToken.current += 1;
		followingRef.current = false;
		publishAtBottom(false);
		setHighlighted(focusEntry);
		const token = ++focusToken.current;
		const scroll = () => {
			if (focusToken.current !== token) return;
			virtualizer.current?.scrollToIndex(index, { align: "center" });
		};
		requestAnimationFrame(scroll);
		// A page that was just prepended is measured after its first paint; align once more.
		const settle = setTimeout(scroll, 80);
		if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
		highlightTimer.current = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
		return () => clearTimeout(settle);
	}, [focusEntry, rows, turns, openTurns, publishAtBottom]);

	useEffect(() => {
		return () => {
			if (highlightTimer.current !== null) clearTimeout(highlightTimer.current);
		};
	}, []);

	return (
		<div className="relative min-h-0 flex-1" data-slot="transcript">
			<div
				ref={scrollRef}
				data-testid="transcript-scroller"
				data-loaded-count={items.length}
				data-first-id={firstId}
				data-at-bottom={atBottom ? "true" : "false"}
				role="log"
				aria-label={t`Conversation`}
				aria-live="polite"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the scroller is focusable for keyboard scrolling and jump-to-latest
				tabIndex={0}
				onScroll={onScroll}
				className="h-full overflow-y-auto overscroll-contain pt-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [overflow-anchor:none]"
			>
				<div ref={sentinelRef} aria-hidden="true" className="absolute top-0 left-0 h-px w-px" />
				{loadingOlder && (
					<div
						data-testid="loading-older"
						className="sticky top-0 z-10 flex items-center justify-center gap-2 border-b bg-background/85 py-1 text-xs text-muted-foreground backdrop-blur"
					>
						<LoaderCircleIcon className="size-3 animate-spin" aria-hidden="true" />
						<Trans>Loading older messages…</Trans>
					</div>
				)}
				{ready && items.length === 0 && (
					<div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{empty}</div>
				)}
				{items.length > 0 && (
					<Virtualizer
						ref={virtualizer}
						data={rows}
						itemSize={120}
						bufferSize={600}
						shift={shift}
						onResize={() => {
							// Measurement changes the content height after the first paint; at
							// the bottom the view follows the end, scrolled up it stays put.
							if (followingRef.current) requestAnimationFrame(pinToEnd);
						}}
					>
						{(row) =>
							row.kind === "summary" ? (
								<TurnSummaryRow
									key={row.key}
									durationMs={row.durationMs}
									open={row.open}
									onToggle={() => toggleTurn(row.turnKey)}
								/>
							) : row.kind === "deliveries" ? (
								<TurnDeliveries key={row.key} deliveries={row.deliveries} />
							) : (
								<TranscriptRow
									key={row.key}
									item={row.item}
									streams={streams}
									sessionActive={sessionActive}
									highlighted={highlighted !== null && row.item.entryId === highlighted}
								/>
							)
						}
					</Virtualizer>
				)}
			</div>
			{!atBottom && (
				<div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
					<Button
						type="button"
						size="icon-lg"
						variant="outline"
						data-testid="jump-to-latest"
						aria-label={t`Jump to latest`}
						title={t`Jump to latest`}
						className="pointer-events-auto rounded-full bg-background shadow-sm dark:bg-background"
						onClick={() => settleToEnd()}
					>
						<ArrowDownIcon />
					</Button>
				</div>
			)}
		</div>
	);
}

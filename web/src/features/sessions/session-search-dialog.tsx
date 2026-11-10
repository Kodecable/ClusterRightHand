import type { SessionListScope, SessionSearchHit, SessionSearchItem } from "@crh/api";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { ErrorText } from "@/components/error-state";
import { RelativeTime } from "@/components/relative-time";
import { Spinner } from "@/components/spinner";
import { StatusText } from "@/components/status-badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced";
import { flattenCursorPages, lastCursor } from "@/lib/api/query";
import { sessionStatusTone, sessionUiState } from "@/lib/status";
import { cn } from "@/lib/utils";
import { SESSION_LIST_SCOPE, useSessionSearch } from "./api";
import { HighlightedText } from "./search-highlight";
import { sessionTitle } from "./session-item";

/** How long the typed text settles before the request (doc/design/webui.md "Session content search"). */
const DEBOUNCE_MS = 250;
/** The server caps a query at eight keywords; highlighting follows the same split. */
const KEYWORDS_MAX = 8;

// One dialog per app, opened by the list's search button and the global shortcut.
let searchOpen = false;
const openListeners = new Set<() => void>();

function publishOpen(): void {
	for (const listener of openListeners) listener();
}

/** Opens the session search dialog; the mounted {@link SessionSearchDialog} reacts. */
export function openSessionSearch(): void {
	if (searchOpen) return;
	searchOpen = true;
	publishOpen();
}

/** Closes the session search dialog, also usable from tests that open it directly. */
export function closeSessionSearch(): void {
	if (!searchOpen) return;
	searchOpen = false;
	publishOpen();
}

function subscribeOpen(listener: () => void): () => void {
	openListeners.add(listener);
	return () => openListeners.delete(listener);
}

function useSearchOpen(): [boolean, (open: boolean) => void] {
	const open = useSyncExternalStore(
		subscribeOpen,
		() => searchOpen,
		() => false,
	);
	return [
		open,
		(next) => {
			if (next) openSessionSearch();
			else closeSessionSearch();
		},
	];
}

type SearchRow =
	| { kind: "header"; key: string; item: SessionSearchItem }
	| { kind: "hit"; key: string; item: SessionSearchItem; hit: SessionSearchHit }
	| { kind: "more"; key: string; item: SessionSearchItem; hidden: number };

/** The translated state text of a result's session. */
const SESSION_STATE_LABELS = {
	running: msg`Running`,
	awaiting: msg`Awaiting`,
	idle: msg`Idle`,
} as const;

function sessionStateLabel(state: SessionSearchItem["state"], i18n: I18n): string {
	return i18n._(SESSION_STATE_LABELS[sessionUiState(state)]);
}

/**
 * The session search dialog (doc/design/webui.md "Session content search"): one debounced
 * `GET /api/sessions/search` query per keyword set, grouped result rows and a
 * flat listbox for Up/Down/Enter navigation. A session header opens the root
 * session; a hit opens the entry's session with `?entry=<id>`, which the
 * session page scrolls to and highlights (doc/design/webui.md "Jumping to a message").
 *
 * Mounted once in the authenticated shell. The list's search button and
 * Ctrl/⌘+K open it through the module store, so any page can reach it.
 */
export function SessionSearchDialog({
	scope = SESSION_LIST_SCOPE,
}: {
	/** The session list's scope: `visible` unless a caller renders another list. */
	scope?: SessionListScope;
}) {
	const { t, i18n } = useLingui();
	const navigate = useNavigate();
	const listId = useId();
	const [open, setOpen] = useSearchOpen();
	const [input, setInput] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const listRef = useRef<HTMLDivElement | null>(null);
	const trimmed = input.trim();
	const debounced = useDebouncedValue(trimmed, DEBOUNCE_MS);
	// Clearing the box is immediate; otherwise a new keyword set waits out the debounce.
	const q = trimmed === "" ? "" : debounced;
	const keywords = useMemo(() => q.split(/\s+/).filter(Boolean).slice(0, KEYWORDS_MAX), [q]);
	const search = useSessionSearch(open ? q : "", scope);
	const items = useMemo(() => flattenCursorPages(search.data), [search.data]);
	const hasMore = lastCursor(search.data) !== null;
	const pending = open && q !== "" && (q !== trimmed || search.isPending);

	const rows = useMemo(() => {
		const result: SearchRow[] = [];
		for (const item of items) {
			result.push({ kind: "header", key: `header:${item.id}`, item });
			// The server sends at most three; slicing keeps the dialog's promise if that changes.
			const hits = item.hits.slice(0, 3);
			for (const hit of hits) {
				result.push({ kind: "hit", key: `hit:${item.id}:${hit.sessionId}:${hit.entryId}`, item, hit });
			}
			const hidden = item.hitCount - hits.length;
			if (hidden > 0) result.push({ kind: "more", key: `more:${item.id}`, item, hidden });
		}
		return result;
	}, [items]);
	const active = rows.length === 0 ? -1 : Math.min(activeIndex, rows.length - 1);

	// A new keyword set starts from its first row again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the query changes
	useEffect(() => {
		setActiveIndex(0);
	}, [q]);

	// Ctrl+K / ⌘K opens the dialog from every authenticated page; the browser's own
	// find/address shortcut must not run instead.
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
			if (event.key.toLowerCase() !== "k") return;
			event.preventDefault();
			openSessionSearch();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// Keep the active row visible while the arrow keys move through a long result.
	useEffect(() => {
		if (active < 0) return;
		const element = listRef.current?.querySelector<HTMLElement>(`[data-search-row="${active}"]`);
		if (typeof element?.scrollIntoView === "function") element.scrollIntoView({ block: "nearest" });
	}, [active]);

	const changeOpen = (next: boolean) => {
		setOpen(next);
		if (!next) {
			setInput("");
			setActiveIndex(0);
		}
	};

	const openRow = (row: SearchRow) => {
		changeOpen(false);
		if (row.kind === "hit") {
			void navigate({
				to: "/sessions/$sessionId",
				params: { sessionId: row.hit.sessionId },
				search: { entry: row.hit.entryId },
			});
			return;
		}
		void navigate({ to: "/sessions/$sessionId", params: { sessionId: row.item.id } });
	};

	const move = (delta: number) => {
		if (rows.length === 0) return;
		setActiveIndex((current) => Math.max(0, Math.min(rows.length - 1, Math.min(current, rows.length - 1) + delta)));
	};

	const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			move(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			move(-1);
			return;
		}
		if (event.key === "Home") {
			event.preventDefault();
			setActiveIndex(0);
			return;
		}
		if (event.key === "End") {
			event.preventDefault();
			if (rows.length > 0) setActiveIndex(rows.length - 1);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const row = rows[active];
			if (row !== undefined) openRow(row);
		}
	};

	const loadMore = () => {
		if (!hasMore || search.isFetchingNextPage) return;
		void search.fetchNextPage();
	};

	const showIdle = open && q === "";
	const showEmpty = !pending && q !== "" && search.data !== undefined && items.length === 0 && !search.isError;
	const showResults = q !== "" && items.length > 0;

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl" data-testid="session-search-dialog">
				<DialogTitle className="sr-only">
					<Trans>Search sessions</Trans>
				</DialogTitle>
				<div className="flex items-center gap-2 border-b px-3 py-2 pr-10">
					<SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<Input
						autoFocus
						type="text"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={onInputKeyDown}
						placeholder={t`Search sessions…`}
						aria-label={t`Search sessions`}
						data-testid="session-search-input"
						role="combobox"
						aria-expanded={open}
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
						className="h-7 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
					/>
					{pending && <Spinner className="size-3.5" decorative />}
				</div>

				<ErrorText error={search.error} className="border-b px-3 py-2" />

				<div
					ref={listRef}
					id={listId}
					role="listbox"
					aria-label={t`Search results`}
					className="max-h-[min(60vh,30rem)] min-h-24 overflow-y-auto overscroll-contain p-1.5"
					onScroll={(event) => {
						const element = event.currentTarget;
						if (element.scrollTop + element.clientHeight >= element.scrollHeight - 160) loadMore();
					}}
				>
					{showIdle && (
						<p className="px-2 py-8 text-center text-sm text-muted-foreground">
							<Trans>Type keywords separated by spaces</Trans>
						</p>
					)}

					{pending && rows.length === 0 && (
						<div className="px-2 py-8">
							<Spinner className="mx-auto" label={t`Searching`} />
						</div>
					)}

					{showEmpty && (
						<p className="px-2 py-8 text-center text-sm text-muted-foreground">
							<Trans>No matching sessions</Trans>
						</p>
					)}

					{showResults &&
						items.map((item) => {
							const title = sessionTitle(item, t`New Session`);
							const groupRows = rows.filter((row) => row.item.id === item.id);
							return (
								// biome-ignore lint/a11y/useSemanticElements: a listbox group cannot be a fieldset; its name is the session title.
								<div key={item.id} role="group" aria-label={title} className="py-0.5">
									{groupRows.map((row) => {
										const index = rows.indexOf(row);
										const selected = index === active;
										return (
											// biome-ignore lint/a11y/useFocusableInteractive: the combobox input keeps focus and aria-activedescendant points here.
											// biome-ignore lint/a11y/useKeyWithClickEvents: Enter on the input opens the active option; click is its mouse counterpart.
											<div
												key={row.key}
												id={`${listId}-${index}`}
												role="option"
												aria-selected={selected}
												data-search-row={index}
												data-active={selected ? "true" : "false"}
												data-kind={row.kind}
												onMouseEnter={() => setActiveIndex(index)}
												onClick={() => openRow(row)}
												className={cn("cursor-pointer rounded-md", selected && "bg-accent text-accent-foreground")}
											>
												{row.kind === "header" ? (
													<div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
														<span className="min-w-0 flex-1 truncate text-sm font-medium">
															{item.titleMatch ? <HighlightedText text={title} keywords={keywords} /> : title}
														</span>
														<span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
															{item.ownerName}
														</span>
														<RelativeTime value={item.updatedAt} className="shrink-0 text-xs text-muted-foreground" />
														<StatusText tone={sessionStatusTone(item.state)} className="shrink-0 text-xs">
															{sessionStateLabel(item.state, i18n)}
														</StatusText>
													</div>
												) : row.kind === "hit" ? (
													<div className="flex min-w-0 flex-col gap-0.5 py-1.5 pr-2 pl-4">
														<div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
															<span className="shrink-0 font-medium text-foreground">
																{row.hit.role === "user" ? <Trans>You</Trans> : <Trans>Assistant</Trans>}
															</span>
															{row.hit.sessionId !== item.id && (
																<span className="min-w-0 truncate">
																	·{" "}
																	{row.hit.sessionTitle === null || row.hit.sessionTitle.trim() === "" ? (
																		<Trans>Subagent</Trans>
																	) : (
																		<Trans>Subagent: {row.hit.sessionTitle}</Trans>
																	)}
																</span>
															)}
															<RelativeTime value={row.hit.at} className="shrink-0" />
														</div>
														<p className="line-clamp-2 text-xs text-muted-foreground">
															<HighlightedText text={row.hit.snippet} keywords={keywords} />
														</p>
													</div>
												) : (
													<p className="px-2 py-1 pl-4 text-xs text-muted-foreground">
														<Plural value={row.hidden} one="# more match" other="# more matches" />
													</p>
												)}
											</div>
										);
									})}
								</div>
							);
						})}

					{search.isFetchingNextPage && (
						<div className="px-2 py-2">
							<Spinner className="mx-auto size-4" label={t`Loading more`} />
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

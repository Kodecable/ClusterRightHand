import type { PtyAttachServerFrame, PtyState, PtyView, PtyViewer } from "@crh/api";
import { Trans } from "@lingui/react/macro";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ExtraKeysBar } from "./extra-keys";
import {
	BASE_FONT_SIZE,
	type CellMetrics,
	fitCellFont,
	fitGrid,
	TERMINAL_FONT_FAMILY,
	TERMINAL_LINE_HEIGHT,
	type TerminalDimensions,
	viewportHeightBudget,
} from "./fit";
import { forwardUserInput, StickyModifiers } from "./user-input";

/** How many times an unexpected socket close re-attaches before the viewer is told the link is lost. */
const MAX_RECONNECT_ATTEMPTS = 5;

/** The server's error frame; it is not in the shared type union, which only describes the attach lifecycle. */
type AttachErrorFrame = { type: "error"; message: string };

/** The live facts a viewer applies from the attach protocol's JSON frames. */
export interface TerminalLiveState {
	rows: number;
	cols: number;
	state: PtyState;
	/** The program's untrusted title; omitted by a snapshot. */
	title?: string;
	/** Omitted by a snapshot, which carries no viewer list; the page keeps the last known one. */
	viewers?: PtyViewer[];
}

export interface TerminalViewHandle {
	/** The rows/columns that fill the viewer's area at the default font, without applying them. */
	fitToWindow(): TerminalDimensions | undefined;
}

export interface TerminalViewProps {
	terminal: PtyView;
	/** A `state` or `snapshot` frame changed the size, the viewers or the lifecycle. */
	onState?: (state: TerminalLiveState) => void;
	/** The process ended; the last screen stays. */
	onExited?: (exitCode: number, reason: "exited" | "helper_lost") => void;
	/** The server closed the attachment (`closed` frame). */
	onClosed?: (reason: string) => void;
	/** A protocol or server error frame. */
	onError?: (message: string) => void;
}

/** The same-origin attach URL; the session cookie authenticates it, as it does the REST routes. */
function attachUrl(id: string): string {
	const scheme = window.location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${window.location.host}/api/ptys/${encodeURIComponent(id)}/attach`;
}

/** One cell of the grid, from the `.xterm-screen` box the renderer sized for `cols × rows`. */
export function measureCell(term: Terminal): CellMetrics | undefined {
	const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
	if (screen === null || screen === undefined) return undefined;
	const rect = screen.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0 || term.cols <= 0 || term.rows <= 0) return undefined;
	return { width: rect.width / term.cols, height: rect.height / term.rows };
}

/**
 * One cell at exactly `fontSize`. A different size is set only for the synchronous read and restored
 * before this function returns: the browser never paints the intermediate font, and the renderer's
 * device-pixel-rounded cell metrics are measured where they matter instead of scaled from another
 * size.
 */
export function measureCellAt(term: Terminal, fontSize: number): CellMetrics | undefined {
	const previous = term.options.fontSize ?? BASE_FONT_SIZE;
	if (Math.abs(previous - fontSize) < 0.05) return measureCell(term);
	term.options.fontSize = fontSize;
	const cell = measureCell(term);
	term.options.fontSize = previous;
	return cell;
}

/**
 * The top of `element`'s layout box as if its scrolling ancestors were at the start: a client rect is
 * relative to the viewport, so the scroll offsets above the box are added back. The height budget
 * reads the terminal box this way, so scrolling the page cannot change it.
 */
export function unscrolledTop(element: HTMLElement): number {
	let offset = 0;
	for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
		offset += ancestor.scrollTop;
	}
	return element.getBoundingClientRect().top + offset;
}

/**
 * The xterm.js side of one terminal (doc/design/webui.md "Terminals page"): a WebSocket attachment
 * whose binary frames are terminal bytes in both directions and whose text frames are the snapshot,
 * the state changes and the end of the process.
 *
 * The terminal keeps its own rows and columns. The viewer scales its font so the full grid fits: the
 * available width picks the font, and the height budget (the layout viewport minus everything above
 * the box in the unscrolled layout, the extra-keys bar and the viewer box's own padding and border)
 * only caps it, so a soft keyboard cannot make the text jump and the last rows stay visible without
 * scrolling. xterm sizes its element to the grid at that font, so the box is exactly the grid plus its
 * padding and border; the page scrolls when that does not fit.
 * When one dimension has room left over the grid is centered horizontally and stays at the top; at the
 * minimum font the area scrolls instead of cropping. "Fit to window" proposes the grid the area would
 * hold at the default font, measured at exactly that font and keeping the default 80:24 shape, and
 * only that explicit resize changes the terminal's size. Opening the page, returning to it and
 * re-attaching focus the terminal, so keys go to the shell immediately. Only the wheel is forwarded
 * from the mouse, because several people share the terminal (see `user-input.ts`).
 */
export function TerminalView({
	terminal,
	ref,
	onState,
	onExited,
	onClosed,
	onError,
}: TerminalViewProps & { ref?: Ref<TerminalViewHandle> }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const extraKeysRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | undefined>(undefined);
	const fitFontRef = useRef<(() => void) | undefined>(undefined);
	const fitToWindowRef = useRef<(() => TerminalDimensions | undefined) | undefined>(undefined);
	const sticky = useMemo(() => new StickyModifiers(), []);
	const [reconnecting, setReconnecting] = useState(false);
	const [connectionLost, setConnectionLost] = useState(false);
	// The callbacks change every render; the socket effect must not restart for them.
	const callbacks = useRef({ onState, onExited, onClosed, onError });
	callbacks.current = { onState, onExited, onClosed, onError };
	// The setup effect uses the size current when it starts; later sizes come from the effect below.
	const setupSize = useRef(terminal.size);
	setupSize.current = terminal.size;

	useImperativeHandle(
		ref,
		() => ({
			fitToWindow() {
				return fitToWindowRef.current?.();
			},
		}),
		[],
	);

	useEffect(() => {
		const container = containerRef.current;
		const scroll = scrollRef.current;
		if (container === null || scroll === null) return;
		const term = new Terminal({
			cursorBlink: true,
			fontFamily: TERMINAL_FONT_FAMILY,
			fontSize: BASE_FONT_SIZE,
			lineHeight: TERMINAL_LINE_HEIGHT,
			scrollback: 5_000,
			theme: {
				background: "#0b0e14",
				foreground: "#d6dde7",
				cursor: "#d6dde7",
				selectionBackground: "#334155",
			},
		});
		term.open(container);
		term.resize(setupSize.current.cols, setupSize.current.rows);
		terminalRef.current = term;

		/** The scroll area's inner width, without its padding; the width always decides the font. */
		const contentWidth = (): number | undefined => {
			const style = getComputedStyle(scroll);
			const width = scroll.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			return width > 0 ? width : undefined;
		};

		/**
		 * The height a full grid may use. The layout viewport (`window.innerHeight`) is the one that does
		 * not shrink with a soft keyboard or a sliding URL bar. The box's top is read as if its scrolling
		 * ancestors were at the start, so everything the page puts above it (top bar, back link, heading,
		 * actions, meta line) comes out of the budget and scrolling the page does not change it. The
		 * extra-keys bar and the scroll area's vertical padding and border come out too.
		 */
		const heightBudget = (): number | undefined => {
			const extraKeys = extraKeysRef.current?.getBoundingClientRect().height ?? 0;
			const style = getComputedStyle(scroll);
			const length = (value: string): number => {
				const parsed = Number.parseFloat(value);
				return Number.isFinite(parsed) ? parsed : 0;
			};
			// The scroll area draws its padding and border around the grid, so the box is that much taller.
			const boxChrome =
				length(style.paddingTop) +
				length(style.paddingBottom) +
				length(style.borderTopWidth) +
				length(style.borderBottomWidth);
			return viewportHeightBudget(window.innerHeight, unscrolledTop(scroll), extraKeys, boxChrome);
		};

		/**
		 * Sizes the font so the full `rows × cols` grid fits: the width picks it and the height budget
		 * only caps it. xterm sizes its element to the grid, so the observers below watch the width alone;
		 * the fit measures again after applying the font and corrects device-pixel rounding once.
		 */
		const fitFont = () => {
			const width = contentWidth();
			const budget = heightBudget();
			if (width === undefined || budget === undefined) return;
			const current = term.options.fontSize ?? BASE_FONT_SIZE;
			fitCellFont(width, budget, term.cols, term.rows, current, {
				measure: () => measureCell(term),
				applyFont: (fontSize) => {
					term.options.fontSize = fontSize;
				},
			});
		};
		fitFontRef.current = fitFont;

		/**
		 * Measures one cell at exactly the default font and proposes the grid the width and the height
		 * budget, which already leaves out the box's padding and border, would hold there in the default
		 * 80:24 shape. It never applies the grid: the page sends it through the explicit resize route and
		 * every viewer adopts the server's answer.
		 */
		const fitToWindow = (): TerminalDimensions | undefined => {
			const area = contentWidth();
			const budget = heightBudget();
			if (area === undefined || budget === undefined) return undefined;
			const cell = measureCellAt(term, BASE_FONT_SIZE);
			if (cell === undefined) return undefined;
			return fitGrid({ width: area, height: budget }, cell);
		};
		fitToWindowRef.current = fitToWindow;

		// Only a width or a layout-viewport height change refits: the area's height now follows the
		// font, and a visual-viewport change must not touch the text. A rotation changes both.
		let lastWidth = -1;
		let lastViewportHeight = window.innerHeight;
		const resizeObserver = new ResizeObserver(() => {
			const width = scroll.clientWidth;
			if (Math.abs(width - lastWidth) < 1) return;
			lastWidth = width;
			fitFont();
		});
		resizeObserver.observe(scroll);
		const onWindowResize = () => {
			if (window.innerHeight === lastViewportHeight && Math.abs(scroll.clientWidth - lastWidth) < 1) return;
			lastViewportHeight = window.innerHeight;
			lastWidth = scroll.clientWidth;
			fitFont();
		};
		window.addEventListener("resize", onWindowResize);

		const focus = () => term.focus();
		window.addEventListener("focus", focus);
		const onVisibility = () => {
			if (!document.hidden) term.focus();
		};
		document.addEventListener("visibilitychange", onVisibility);
		const firstFrame = requestAnimationFrame(() => {
			fitFont();
			term.focus();
		});

		let disposed = false;
		let stopped = false;
		let socket: WebSocket | undefined;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let attempts = 0;

		const clearRetry = () => {
			if (retry !== undefined) {
				clearTimeout(retry);
				retry = undefined;
			}
		};

		const applyState = (frame: Extract<PtyAttachServerFrame, { type: "state" }>) => {
			if (term.cols !== frame.cols || term.rows !== frame.rows) {
				term.resize(frame.cols, frame.rows);
				fitFont();
			}
			callbacks.current.onState?.({
				rows: frame.rows,
				cols: frame.cols,
				state: frame.state,
				title: frame.title,
				viewers: frame.viewers,
			});
		};

		const handleText = (text: string) => {
			let frame: PtyAttachServerFrame | AttachErrorFrame;
			try {
				frame = JSON.parse(text) as PtyAttachServerFrame | AttachErrorFrame;
			} catch {
				return;
			}
			switch (frame.type) {
				case "snapshot":
					// Each attachment begins with the current screen, so start from a clean one.
					term.reset();
					if (term.cols !== frame.cols || term.rows !== frame.rows) term.resize(frame.cols, frame.rows);
					term.write(frame.data);
					fitFont();
					callbacks.current.onState?.({ rows: frame.rows, cols: frame.cols, state: "running" });
					break;
				case "state":
					applyState(frame);
					break;
				case "exited":
					stopped = true;
					clearRetry();
					callbacks.current.onExited?.(frame.exitCode, frame.reason);
					break;
				case "closed":
					stopped = true;
					clearRetry();
					callbacks.current.onClosed?.(frame.reason);
					break;
				case "error":
					callbacks.current.onError?.(frame.message);
					break;
			}
		};

		const connect = () => {
			if (disposed) return;
			const ws = new WebSocket(attachUrl(terminal.id));
			ws.binaryType = "arraybuffer";
			socket = ws;
			ws.onopen = () => {
				attempts = 0;
				setReconnecting(false);
				setConnectionLost(false);
				term.focus();
			};
			ws.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
				const data = event.data;
				if (typeof data === "string") {
					handleText(data);
					return;
				}
				if (data instanceof ArrayBuffer) {
					term.write(new Uint8Array(data));
					return;
				}
				if (data instanceof Blob) {
					void data.arrayBuffer().then((buffer) => {
						if (!disposed) term.write(new Uint8Array(buffer));
					});
				}
			};
			ws.onclose = () => {
				if (disposed || stopped) return;
				if (attempts >= MAX_RECONNECT_ATTEMPTS) {
					setConnectionLost(true);
					return;
				}
				attempts += 1;
				setReconnecting(true);
				retry = setTimeout(connect, 500 * attempts);
			};
		};

		// Only user input is the program's input: xterm.js also emits its own replies to terminal
		// queries through `onData`, and every attached browser would otherwise answer them. The
		// sticky modifiers transform soft-keyboard text; mouse clicks never reach the shared shell.
		const input = forwardUserInput(
			term,
			(bytes) => {
				if (socket?.readyState === WebSocket.OPEN) socket.send(bytes);
			},
			{ sticky },
		);
		connect();

		return () => {
			disposed = true;
			clearRetry();
			cancelAnimationFrame(firstFrame);
			resizeObserver.disconnect();
			window.removeEventListener("resize", onWindowResize);
			window.removeEventListener("focus", focus);
			document.removeEventListener("visibilitychange", onVisibility);
			input.dispose();
			socket?.close();
			term.dispose();
			terminalRef.current = undefined;
			fitFontRef.current = undefined;
			fitToWindowRef.current = undefined;
		};
		// One terminal per effect; a new id builds a new emulator and attachment.
	}, [terminal.id, sticky]);

	// The server's answer to an explicit resize (and every viewer's state frame) changes the grid.
	useEffect(() => {
		const term = terminalRef.current;
		if (term === undefined) return;
		if (term.cols !== terminal.size.cols || term.rows !== terminal.size.rows) {
			term.resize(terminal.size.cols, terminal.size.rows);
		}
		fitFontRef.current?.();
	}, [terminal.size.cols, terminal.size.rows]);

	return (
		<div className="grid min-w-0 gap-2" data-testid="terminal-view">
			{reconnecting && (
				<p role="status" className="text-xs text-warn">
					<Trans>Reconnecting to the terminal…</Trans>
				</p>
			)}
			{connectionLost && (
				<p role="alert" className="text-sm text-danger">
					<Trans>The connection to the terminal was lost.</Trans>
				</p>
			)}
			<div
				ref={scrollRef}
				data-testid="terminal-screen"
				className="w-full max-w-full min-w-0 overflow-auto rounded-lg border bg-[#0b0e14] p-2"
			>
				{/* The outer box is never narrower than the area, so the inner one centers instead of
				    shifting a too-wide grid past the left, unreachable edge of the scroll area. */}
				<div className="w-max min-w-full">
					<div ref={containerRef} className="mx-auto w-max" />
				</div>
			</div>
			<ExtraKeysBar
				terminalRef={terminalRef}
				sticky={sticky}
				barRef={extraKeysRef}
				hint={
					<p data-testid="terminal-mouse-hint" className="min-w-0 text-xs text-muted-foreground">
						<Trans>Hold Shift while selecting text when a program uses the mouse.</Trans>
					</p>
				}
			/>
		</div>
	);
}

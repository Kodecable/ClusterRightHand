import type { PtyAttachServerFrame, PtyState, PtyView, PtyViewer } from "@crh/api";
import { Trans } from "@lingui/react/macro";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ExtraKeysBar } from "./extra-keys";
import {
	BASE_FONT_SIZE,
	FIT_MARGIN,
	type FitArea,
	fitGrid,
	MAX_FONT_SIZE,
	MIN_FONT_SIZE,
	type TerminalDimensions,
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

/**
 * The xterm.js side of one terminal (doc/design/webui.md "Terminals page"): a WebSocket attachment
 * whose binary frames are terminal bytes in both directions and whose text frames are the snapshot,
 * the state changes and the end of the process.
 *
 * The terminal keeps its own rows and columns. The viewer scales its font so the whole grid fits
 * the available area, width and height, on every window or terminal resize; when one dimension has
 * room left over, the grid is centered horizontally and stays at the top. At the minimum font the
 * terminal area scrolls instead of cropping. "Fit to window" proposes the grid that area would hold
 * at the default font, and only that explicit resize changes the terminal's size. Opening the page,
 * returning to it and re-attaching focus the terminal, so keys go to the shell immediately. Only
 * the wheel is forwarded from the mouse, because several people share the terminal (see
 * `user-input.ts`).
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
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
			fontSize: BASE_FONT_SIZE,
			lineHeight: 1.2,
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

		/** The scroll area's inner size, without its padding. */
		const contentArea = (): FitArea | undefined => {
			const style = getComputedStyle(scroll);
			const width = scroll.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			const height = scroll.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
			if (width <= 0 || height <= 0) return undefined;
			return { width, height };
		};

		/**
		 * Scales the font so the full `rows × cols` grid fits the scroll area. Changing the font does
		 * not change the grid; below the minimum the area scrolls instead. A second pass settles the
		 * cell metrics after the option change.
		 */
		const fitFont = () => {
			if (term.element === undefined) return;
			const screen = term.element.querySelector<HTMLElement>(".xterm-screen");
			if (screen === null) return;
			const rect = screen.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return;
			const area = contentArea();
			if (area === undefined) return;
			const cellWidth = rect.width / term.cols;
			const cellHeight = rect.height / term.rows;
			if (cellWidth <= 0 || cellHeight <= 0) return;
			const current = term.options.fontSize ?? BASE_FONT_SIZE;
			const scale = Math.min(area.width / (cellWidth * term.cols), area.height / (cellHeight * term.rows)) * FIT_MARGIN;
			const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(current * scale * 20) / 20));
			if (Math.abs(next - current) < 0.05) return;
			term.options.fontSize = next;
		};
		fitFontRef.current = fitFont;

		/**
		 * Measures one cell at the current font and proposes the grid the area would hold at the
		 * default font. It never applies the grid: the page sends it through the explicit resize route
		 * and every viewer adopts the server's answer.
		 */
		const fitToWindow = (): TerminalDimensions | undefined => {
			if (term.element === undefined) return undefined;
			const screen = term.element.querySelector<HTMLElement>(".xterm-screen");
			if (screen === null) return undefined;
			const rect = screen.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return undefined;
			const area = contentArea();
			if (area === undefined) return undefined;
			return fitGrid(
				area,
				{ width: rect.width / term.cols, height: rect.height / term.rows },
				term.options.fontSize ?? BASE_FONT_SIZE,
			);
		};
		fitToWindowRef.current = fitToWindow;

		const resizeObserver = new ResizeObserver(() => fitFont());
		resizeObserver.observe(scroll);
		window.addEventListener("resize", fitFont);

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
			window.removeEventListener("resize", fitFont);
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
				className="h-[55vh] max-h-[40rem] min-h-56 w-full max-w-full min-w-0 overflow-auto rounded-lg border bg-[#0b0e14] p-2"
			>
				{/* The outer box is never narrower than the area, so the inner one centers instead of
				    shifting a too-wide grid past the left, unreachable edge of the scroll area. */}
				<div className="w-max min-w-full">
					<div ref={containerRef} className="mx-auto w-max" />
				</div>
			</div>
			<ExtraKeysBar terminalRef={terminalRef} sticky={sticky} />
			<p data-testid="terminal-mouse-hint" className="text-xs text-muted-foreground">
				<Trans>Hold Shift while selecting text when a program uses the mouse.</Trans>
			</p>
		</div>
	);
}

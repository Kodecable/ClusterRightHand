import type { PtyAttachServerFrame, PtyState, PtyView, PtyViewer } from "@crh/api";
import { Trans } from "@lingui/react/macro";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { forwardUserInput } from "./user-input";

/** The largest rows or columns crha accepts (doc/design/pty.md "The terminal object"). */
const MAX_DIMENSION = 1000;

/** How many times an unexpected socket close re-attaches before the viewer is told the link is lost. */
const MAX_RECONNECT_ATTEMPTS = 5;

/** The server's error frame; it is not in the shared type union, which only describes the attach lifecycle. */
type AttachErrorFrame = { type: "error"; message: string };

/** The live facts a viewer applies from the attach protocol's JSON frames. */
export interface TerminalLiveState {
	rows: number;
	cols: number;
	state: PtyState;
	/** Omitted by a snapshot, which carries no viewer list; the page keeps the last known one. */
	viewers?: PtyViewer[];
}

export interface TerminalViewHandle {
	/** The rows/columns the FitAddon proposes for the current container, without applying them. */
	fitToWindow(): { rows: number; cols: number } | undefined;
	focus(): void;
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

function clampDimension(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.min(MAX_DIMENSION, Math.trunc(value)));
}

/**
 * The xterm.js side of one terminal (doc/design/webui.md "Terminals page"): a WebSocket attachment whose
 * binary frames are terminal bytes in both directions and whose text frames are the snapshot, the state
 * changes and the end of the process. Attaching never resizes the terminal; the Fit button asks
 * the page for the dimensions the FitAddon proposes, and this view adopts the size the server answers.
 *
 * An unexpected close re-attaches: the first frame is the current screen, so the viewer resumes from
 * where it was without any stream being replayed.
 */
export function TerminalView({
	terminal,
	ref,
	onState,
	onExited,
	onClosed,
	onError,
}: TerminalViewProps & { ref?: Ref<TerminalViewHandle> }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | undefined>(undefined);
	const fitRef = useRef<FitAddon | undefined>(undefined);
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
				const proposed = fitRef.current?.proposeDimensions();
				if (proposed === undefined) return undefined;
				return { rows: clampDimension(proposed.rows), cols: clampDimension(proposed.cols) };
			},
			focus() {
				terminalRef.current?.focus();
			},
		}),
		[],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;
		const term = new Terminal({
			cursorBlink: true,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			lineHeight: 1.2,
			scrollback: 5_000,
			theme: {
				background: "#0b0e14",
				foreground: "#d6dde7",
				cursor: "#d6dde7",
				selectionBackground: "#334155",
			},
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		term.resize(setupSize.current.cols, setupSize.current.rows);
		terminalRef.current = term;
		fitRef.current = fit;

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
			if (term.cols !== frame.cols || term.rows !== frame.rows) term.resize(frame.cols, frame.rows);
			callbacks.current.onState?.({
				rows: frame.rows,
				cols: frame.cols,
				state: frame.state,
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
		// queries through `onData`, and every attached browser would otherwise answer them.
		const input = forwardUserInput(term, (bytes) => {
			if (socket?.readyState === WebSocket.OPEN) socket.send(bytes);
		});
		connect();

		return () => {
			disposed = true;
			clearRetry();
			input.dispose();
			socket?.close();
			term.dispose();
			terminalRef.current = undefined;
			fitRef.current = undefined;
		};
		// One terminal per effect; a new id builds a new emulator and attachment.
	}, [terminal.id]);

	// The server's answer to an explicit resize (and every viewer's state frame) changes the local grid.
	useEffect(() => {
		const term = terminalRef.current;
		if (term === undefined) return;
		if (term.cols !== terminal.size.cols || term.rows !== terminal.size.rows) {
			term.resize(terminal.size.cols, terminal.size.rows);
		}
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
				ref={containerRef}
				data-testid="terminal-screen"
				className="h-[55vh] max-h-[40rem] min-h-56 w-full min-w-0 overflow-hidden rounded-lg border bg-[#0b0e14] p-2"
			/>
		</div>
	);
}

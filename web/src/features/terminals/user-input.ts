/**
 * The one place that reaches into xterm.js's private core (doc/design/pty.md "crhs", "WebUI").
 *
 * A browser terminal receives two kinds of `onData`: what the user typed (keyboard, paste, IME,
 * mouse reports) and the automatic answers its parser sends back to terminal queries such as a
 * cursor position report (`ESC[6n`) or a device attributes request (`ESC[c`). Only the first kind is
 * input for the program. Forwarding them all makes every attached browser answer every query, and
 * with N viewers the program reads N answers as if they were typed.
 *
 * xterm.js already distinguishes the two: `CoreService.triggerDataEvent(data, wasUserInput)` fires
 * the core's `onUserInput` event synchronously, immediately before `onData`, exactly when the data
 * is user input. `onUserInput` is not part of the public API — the public `Terminal` does not
 * expose it — so this is one of the few places that read `_core` / `coreService`. `@xterm/xterm` is
 * pinned at exactly 6.0.0 for this reason, and `user-input.test.ts` guards the hook: it writes a
 * query to a real terminal and asserts that no reply is forwarded, and that typing still is.
 *
 * Mouse reports in the default (X10) encoding are not `onData` at all: xterm.js sends them through
 * the public `onBinary`, which only user interaction fires, so they need no `onUserInput` gate. The
 * callback receives the bytes to send: UTF-8 for text, and one byte per char code (latin-1) for a
 * binary report, whose char codes above 127 are single bytes and must not be UTF-8 encoded.
 *
 * If the private hook is not there (an unexpected xterm.js build), the helper fails closed: it
 * forwards nothing and reports the mismatch instead of silently forwarding every automatic reply.
 */
import type { IDisposable, Terminal } from "@xterm/xterm";

/** The private core event this module needs; typed locally because it is not public API. */
interface TerminalUserInputCore {
	coreService?: {
		/** Fires synchronously right before `onData` when — and only when — `onData` is user input. */
		onUserInput?: (listener: () => void) => IDisposable;
	};
}

const encoder = new TextEncoder();

/** The bytes to forward; `WebSocket.send` takes only an `ArrayBuffer`-backed view. */
type InputBytes = Uint8Array<ArrayBuffer>;

/** A binary string as its bytes: one per char code (latin-1), never UTF-8. */
function binaryBytes(data: string): InputBytes {
	const bytes = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
	return bytes;
}

/**
 * Wires `forward` to the terminal's user input and calls it with the bytes to send. Text from
 * `onData` is gated by the private `onUserInput` flag and UTF-8 encoded; mouse reports from
 * `onBinary` are always user input and are forwarded as latin-1 bytes. Returns a disposable for
 * all subscriptions.
 */
export function forwardUserInput(terminal: Terminal, forward: (bytes: InputBytes) => void): IDisposable {
	const core = (terminal as unknown as { _core?: TerminalUserInputCore })._core;
	const userInput = core?.coreService?.onUserInput;
	if (typeof userInput !== "function") {
		console.error(
			"@xterm/xterm's private user-input hook (term._core.coreService.onUserInput) is missing; " +
				"refusing to forward terminal data. @xterm/xterm must stay pinned at 6.0.0.",
		);
		return { dispose: () => {} };
	}

	let fromUser = false;
	const userSubscription = userInput.call(core?.coreService, () => {
		fromUser = true;
	});
	const dataSubscription = terminal.onData((data) => {
		if (!fromUser) return;
		fromUser = false;
		forward(encoder.encode(data));
	});
	const binarySubscription = terminal.onBinary((data) => {
		forward(binaryBytes(data));
	});
	return {
		dispose: () => {
			dataSubscription.dispose();
			binarySubscription.dispose();
			userSubscription.dispose();
		},
	};
}

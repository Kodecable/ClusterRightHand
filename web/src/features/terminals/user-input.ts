/**
 * The one place that wires user input into a terminal (doc/design/pty.md "crhs", "WebUI").
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
 * pinned at exactly 6.0.0 for this reason, and `user-input.test.ts` guards the hook.
 *
 * Several people share a terminal, so a viewer never forwards data a mouse click, button or
 * movement produced; only the wheel is forwarded (local scrollback scrolling, xterm's
 * alternate-scroll keys and the program's mouse wheel reports). The decision is by event source:
 * the terminal element's capture listeners mark the mouse event being dispatched, and `onData` /
 * `onBinary` drop anything produced outside a wheel event. Nothing here parses escape sequences.
 *
 * The extra-keys bar dispatches keyboard events to xterm's textarea, so xterm itself generates the
 * sequence for the terminal's current modes. Ctrl and Alt are sticky for the next key (or locked by
 * a double tap); soft-keyboard text typed while one is active is transformed here, in the one
 * input-wiring module.
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

/** One sticky modifier's state: off, applies to the next key, or locked until tapped again. */
export type StickyMode = "off" | "once" | "locked";
export type StickyModifier = "ctrl" | "alt";

/** An immutable snapshot of both sticky modifiers, for `useSyncExternalStore`. */
export interface StickySnapshot {
	ctrl: StickyMode;
	alt: StickyMode;
}

/**
 * The extra-keys bar's Ctrl/Alt state. One tap arms the modifier for the next key; a second
 * consecutive tap locks it until the next tap; a third turns it off. A locked modifier survives
 * `consume`, a one-shot does not.
 */
export class StickyModifiers {
	#snapshot: StickySnapshot = { ctrl: "off", alt: "off" };
	readonly #listeners = new Set<() => void>();

	get snapshot(): StickySnapshot {
		return this.#snapshot;
	}

	tap(modifier: StickyModifier): void {
		const current = this.#snapshot[modifier];
		const next: StickyMode = current === "off" ? "once" : current === "once" ? "locked" : "off";
		this.#set({ ...this.#snapshot, [modifier]: next });
	}

	/** The active modifiers, resetting the one-shot ones; a locked modifier stays locked. */
	consume(): { ctrl: boolean; alt: boolean } {
		const active = { ctrl: this.#snapshot.ctrl !== "off", alt: this.#snapshot.alt !== "off" };
		if (this.#snapshot.ctrl === "once" || this.#snapshot.alt === "once") {
			this.#set({
				ctrl: this.#snapshot.ctrl === "once" ? "off" : this.#snapshot.ctrl,
				alt: this.#snapshot.alt === "once" ? "off" : this.#snapshot.alt,
			});
		}
		return active;
	}

	/** Subscribes to state changes; an arrow field so it can be passed to `useSyncExternalStore` unbound. */
	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	#set(next: StickySnapshot): void {
		if (next.ctrl === this.#snapshot.ctrl && next.alt === this.#snapshot.alt) return;
		this.#snapshot = next;
		for (const listener of this.#listeners) listener();
	}
}

/** One control character per printable character while Ctrl is active, the way a terminal sends it. */
function controlCharacter(character: string): string {
	const code = character.codePointAt(0) ?? 0;
	// Letters, @[\]^_`{|}~ and friends live between 64 and 127; their low five bits are the C0 code.
	if (code >= 64 && code <= 127) return String.fromCharCode(code & 0x1f);
	return character;
}

/**
 * The bytes soft-keyboard text becomes while Ctrl and/or Alt are active: Ctrl maps every printable
 * character to its control code (`c & 0x1f`), Alt prefixes the result with ESC.
 */
export function transformModifiedText(text: string, modifiers: { ctrl: boolean; alt: boolean }): string {
	if (text === "") return "";
	let result = text;
	if (modifiers.ctrl) result = [...result].map(controlCharacter).join("");
	if (modifiers.alt) result = `\u001b${result}`;
	return result;
}

/** Whether every character is printable text, so sticky modifiers apply to it as typed text. */
function isPrintableText(data: string): boolean {
	if (data === "") return false;
	for (const character of data) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 32 || code === 127) return false;
	}
	return true;
}

/** One key of the extra-keys bar. `keyCode` is what xterm.js's keyboard evaluator reads. */
export interface ExtraKey {
	id: string;
	label: string;
	key: string;
	keyCode: number;
	shiftKey?: boolean;
}

/**
 * The extra keys below the terminal, in display order. Ctrl and Alt are handled by the bar as
 * sticky toggles; the rest are dispatched to xterm's textarea.
 */
export const EXTRA_KEYS: readonly ExtraKey[] = [
	{ id: "escape", label: "Esc", key: "Escape", keyCode: 27 },
	{ id: "tab", label: "Tab", key: "Tab", keyCode: 9 },
	{ id: "up", label: "↑", key: "ArrowUp", keyCode: 38 },
	{ id: "down", label: "↓", key: "ArrowDown", keyCode: 40 },
	{ id: "left", label: "←", key: "ArrowLeft", keyCode: 37 },
	{ id: "right", label: "→", key: "ArrowRight", keyCode: 39 },
	{ id: "home", label: "Home", key: "Home", keyCode: 36 },
	{ id: "end", label: "End", key: "End", keyCode: 35 },
	{ id: "pageUp", label: "PgUp", key: "PageUp", keyCode: 33 },
	{ id: "pageDown", label: "PgDn", key: "PageDown", keyCode: 34 },
	{ id: "pipe", label: "|", key: "|", keyCode: 220, shiftKey: true },
	{ id: "tilde", label: "~", key: "~", keyCode: 192, shiftKey: true },
	{ id: "slash", label: "/", key: "/", keyCode: 191 },
	{ id: "dash", label: "-", key: "-", keyCode: 189 },
];

/**
 * Sends one extra key by dispatching a `keydown` on xterm's textarea, where xterm's own keyboard
 * handler turns it into the sequence for the current terminal modes. Ctrl and Alt are taken from
 * the sticky state, so a locked modifier applies to every bar key and a one-shot to this one.
 */
export function pressExtraKey(terminal: Terminal, extra: ExtraKey, sticky: StickyModifiers): void {
	const textarea = terminal.textarea;
	if (textarea === undefined) return;
	const modifiers = sticky.consume();
	const event = new KeyboardEvent("keydown", {
		key: extra.key,
		bubbles: true,
		cancelable: true,
		ctrlKey: modifiers.ctrl,
		altKey: modifiers.alt,
		shiftKey: extra.shiftKey === true,
	});
	// KeyboardEvent's constructor ignores keyCode, but xterm.js's evaluator reads it.
	Object.defineProperties(event, {
		keyCode: { value: extra.keyCode },
		which: { value: extra.keyCode },
	});
	textarea.dispatchEvent(event);
	terminal.focus();
}

/** The mouse events a viewer suppresses; a wheel's data is still forwarded. */
const SUPPRESSED_MOUSE_EVENTS = ["mousedown", "mouseup", "mousemove", "click", "auxclick"] as const;

/**
 * Wires `forward` to the terminal's user input and calls it with the bytes to send. Text from
 * `onData` is gated by the private `onUserInput` flag and UTF-8 encoded; a soft-keyboard text that
 * arrives while the sticky modifiers are active is transformed first. Mouse reports from
 * `onBinary` are forwarded only during a wheel event, as are `onData` bytes produced by a wheel.
 * Returns a disposable for all subscriptions and DOM listeners.
 */
export function forwardUserInput(
	terminal: Terminal,
	forward: (bytes: InputBytes) => void,
	options: { sticky?: StickyModifiers } | StickyModifiers = {},
): IDisposable {
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
	let mouseKind: "wheel" | "other" | null = null;
	const sticky = options instanceof StickyModifiers ? options : options.sticky;
	const userSubscription = userInput.call(core?.coreService, () => {
		fromUser = true;
	});
	const dataSubscription = terminal.onData((data) => {
		if (!fromUser) return;
		fromUser = false;
		if (data === "" || mouseKind === "other") return;
		const modifiers = sticky?.consume();
		if (modifiers !== undefined && (modifiers.ctrl || modifiers.alt) && isPrintableText(data)) {
			forward(encoder.encode(transformModifiedText(data, modifiers)));
			return;
		}
		forward(encoder.encode(data));
	});

	const listeners: { type: string; listener: EventListener; capture: boolean }[] = [];
	const addMouseListener = (
		type: (typeof SUPPRESSED_MOUSE_EVENTS)[number] | "wheel",
		listener: EventListener,
		capture: boolean,
	) => {
		terminal.element?.addEventListener(type, listener, capture);
		listeners.push({ type, listener, capture });
	};
	const mark =
		(kind: "wheel" | "other"): EventListener =>
		() => {
			mouseKind = kind;
			queueMicrotask(() => {
				if (mouseKind === kind) mouseKind = null;
			});
		};
	const clear: EventListener = () => {
		mouseKind = null;
	};
	const markOther = (): void => {
		mark("other")(new Event("mouse"));
	};
	for (const type of SUPPRESSED_MOUSE_EVENTS) {
		addMouseListener(type, markOther, true);
		addMouseListener(type, clear, false);
	}
	addMouseListener("wheel", mark("wheel"), true);
	addMouseListener("wheel", clear, false);

	// A button held inside the terminal keeps reporting mouseup and mousemove on the document
	// (xterm.js binds them there), so those reports are marked too. A bar-button click never sets
	// this flag, and its synthetic key still reaches the terminal.
	let dragging = false;
	const startDrag: EventListener = () => {
		dragging = true;
	};
	const endDrag: EventListener = () => {
		dragging = false;
	};
	const dragMove: EventListener = () => {
		if (dragging) markOther();
	};
	const dragUp: EventListener = () => {
		if (dragging) markOther();
		dragging = false;
	};
	terminal.element?.addEventListener("mousedown", startDrag, true);
	terminal.element?.addEventListener("mouseup", endDrag, true);
	document.addEventListener("mousemove", dragMove, true);
	document.addEventListener("mouseup", dragUp, true);

	const binarySubscription = terminal.onBinary((data) => {
		// onBinary is mouse-only: nothing but a wheel may send it from this viewer.
		if (mouseKind !== "wheel") return;
		forward(binaryBytes(data));
	});
	return {
		dispose: () => {
			dataSubscription.dispose();
			binarySubscription.dispose();
			userSubscription.dispose();
			for (const { type, listener, capture } of listeners) {
				terminal.element?.removeEventListener(type, listener, capture);
			}
			listeners.length = 0;
			terminal.element?.removeEventListener("mousedown", startDrag, true);
			terminal.element?.removeEventListener("mouseup", endDrag, true);
			document.removeEventListener("mousemove", dragMove, true);
			document.removeEventListener("mouseup", dragUp, true);
		},
	};
}

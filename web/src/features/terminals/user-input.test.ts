import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EXTRA_KEYS, forwardUserInput, pressExtraKey, StickyModifiers, transformModifiedText } from "./user-input";

/** Resolves once the terminal has parsed everything written so far. */
function write(terminal: Terminal, data: string): Promise<void> {
	return new Promise((resolve) => terminal.write(data, resolve));
}

const terminals: Terminal[] = [];
const decoder = new TextDecoder();

/** The forwarded bytes as the UTF-8 text they encode; binary reports are not text. */
function text(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

function makeTerminal(options: { cols?: number; rows?: number } = {}): Terminal {
	const terminal = new Terminal({ cols: options.cols ?? 80, rows: options.rows ?? 24 });
	terminals.push(terminal);
	return terminal;
}

function openTerminal(): { terminal: Terminal; element: HTMLElement } {
	const terminal = makeTerminal();
	const container = document.createElement("div");
	document.body.append(container);
	terminal.open(container);
	const element = terminal.element;
	if (element === undefined) throw new Error("xterm.js did not create its element");
	return { terminal, element };
}

afterEach(() => {
	for (const terminal of terminals.splice(0)) terminal.dispose();
});

describe("forwardUserInput", () => {
	test("does not forward the emulator's automatic replies to terminal queries", async () => {
		const terminal = makeTerminal();
		const forwarded: Uint8Array[] = [];
		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes));

		// xterm.js answers both queries through `onData`, but neither answer is user input.
		await write(terminal, "prompt$ \u001b[6n\u001b[c");

		expect(forwarded).toEqual([]);
		subscription.dispose();
	});

	test("forwards typing and paste, and nothing after them", async () => {
		const terminal = makeTerminal();
		const container = document.createElement("div");
		document.body.append(container);
		terminal.open(container);
		const forwarded: Uint8Array[] = [];
		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes));

		// `input` is how the browser hands a keyboard event's key sequence to the core.
		terminal.input("ls -la\r");
		terminal.input("x");
		// A paste is user input too, and goes through the same core event.
		terminal.paste("pasted text");
		expect(forwarded.map(text)).toEqual(["ls -la\r", "x", "pasted text"]);

		// A reply emitted while parsing output right after user input is still not user input.
		await write(terminal, "\u001b[6n");
		expect(forwarded.map(text)).toEqual(["ls -la\r", "x", "pasted text"]);
		subscription.dispose();
	});

	test("forwards default-encoding mouse reports from onBinary as latin-1 bytes", async () => {
		const { terminal, element } = openTerminal();
		const forwarded: Uint8Array[] = [];
		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes));

		// Normal mouse tracking without SGR: xterm.js encodes these reports in the default (X10)
		// encoding and emits them through `onBinary`, never through `onData`. A wheel event is the
		// only source the terminal page forwards `onBinary` from; drive the core's event during one.
		await write(terminal, "\u001b[?1000h");
		expect(terminal.modes.mouseTrackingMode).toBe("vt200");
		const core = (
			terminal as unknown as {
				_core: { coreService: { triggerBinaryEvent(data: string): void } };
			}
		)._core;
		const report = `\u001b[M${String.fromCharCode(32, 133, 201)}`;
		element.addEventListener("wheel", () => core.coreService.triggerBinaryEvent(report), { capture: true, once: true });
		element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }));

		expect(forwarded).toHaveLength(1);
		expect(Array.from(forwarded[0] ?? [])).toEqual([27, 91, 77, 32, 133, 201]);
		subscription.dispose();
	});

	test("does not forward data a click or movement produced, only a wheel's", async () => {
		const { terminal, element } = openTerminal();
		const forwarded: Uint8Array[] = [];
		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes));
		await write(terminal, "\u001b[?1000h\u001b[?1006h");
		expect(terminal.modes.mouseTrackingMode).toBe("vt200");

		const screen = element.querySelector(".xterm-screen") as HTMLElement;
		const core = (
			terminal as unknown as {
				_core: {
					coreService: {
						triggerDataEvent(data: string, wasUserInput?: boolean): void;
						triggerBinaryEvent(data: string): void;
					};
				};
			}
		)._core;
		// jsdom has no layout, so the test supplies the event xterm.js would generate during each
		// mouse handler; the source marker, not the bytes, is what the module decides on.
		const sendClickData = () => {
			core.coreService.triggerDataEvent("\u001b[<0;2;2M", true);
			core.coreService.triggerBinaryEvent("\u001b[M !!");
		};
		element.addEventListener("mousedown", sendClickData, { capture: true, once: true });
		screen.dispatchEvent(
			new MouseEvent("mousedown", {
				bubbles: true,
				cancelable: true,
				clientX: 10,
				clientY: 10,
				button: 0,
			}),
		);
		screen.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
		screen.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
		screen.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
		expect(forwarded).toEqual([]);

		element.addEventListener("wheel", () => core.coreService.triggerDataEvent("\u001b[<64;2;2M", true), {
			capture: true,
			once: true,
		});
		screen.dispatchEvent(
			new WheelEvent("wheel", {
				bubbles: true,
				cancelable: true,
				clientX: 10,
				clientY: 10,
				deltaY: 120,
				deltaMode: WheelEvent.DOM_DELTA_PIXEL,
			}),
		);
		expect(forwarded.map(text)).toEqual(["\u001b[<64;2;2M"]);
		subscription.dispose();
	});

	test("fails closed when the private user-input hook is missing", () => {
		// A faithful fake without the private hook: onData still fires, nothing may be forwarded.
		let emit: ((data: string) => void) | undefined;
		const terminal = {
			onData: (listener: (data: string) => void) => {
				emit = listener;
				return { dispose: () => {} };
			},
		} as unknown as Terminal;
		const forwarded: Uint8Array[] = [];
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes));
		emit?.("typed");

		expect(forwarded).toEqual([]);
		expect(error).toHaveBeenCalled();
		subscription.dispose();
	});
});

describe("StickyModifiers", () => {
	test("one tap applies once, a double tap locks until tapped again", () => {
		const sticky = new StickyModifiers();
		expect(sticky.snapshot).toEqual({ ctrl: "off", alt: "off" });

		sticky.tap("ctrl");
		expect(sticky.snapshot.ctrl).toBe("once");
		expect(sticky.consume()).toEqual({ ctrl: true, alt: false });
		expect(sticky.snapshot.ctrl).toBe("off");
		expect(sticky.consume()).toEqual({ ctrl: false, alt: false });

		sticky.tap("ctrl");
		sticky.tap("ctrl");
		expect(sticky.snapshot.ctrl).toBe("locked");
		expect(sticky.consume()).toEqual({ ctrl: true, alt: false });
		expect(sticky.snapshot.ctrl).toBe("locked");
		sticky.tap("ctrl");
		expect(sticky.snapshot.ctrl).toBe("off");
	});

	test("notifies subscribers and keeps both modifiers independent", () => {
		const sticky = new StickyModifiers();
		const seen = vi.fn();
		const unsubscribe = sticky.subscribe(seen);
		sticky.tap("ctrl");
		sticky.tap("alt");
		expect(seen).toHaveBeenCalledTimes(2);
		expect(sticky.consume()).toEqual({ ctrl: true, alt: true });
		// Consuming the one-shot modifiers updates the bar's highlight back to off.
		expect(seen).toHaveBeenCalledTimes(3);
		expect(sticky.snapshot).toEqual({ ctrl: "off", alt: "off" });
		unsubscribe();
		sticky.tap("ctrl");
		expect(seen).toHaveBeenCalledTimes(3);
	});
});

describe("transformModifiedText", () => {
	test("turns text into its control characters while Ctrl is active", () => {
		expect(transformModifiedText("c", { ctrl: true, alt: false })).toBe("\u0003");
		expect(transformModifiedText("ls", { ctrl: true, alt: false })).toBe("\u000c\u0013");
		expect(transformModifiedText("@[\\]^_", { ctrl: true, alt: false })).toBe("\u0000\u001b\u001c\u001d\u001e\u001f");
		expect(transformModifiedText("1", { ctrl: true, alt: false })).toBe("1");
	});

	test("prefixes Alt text with ESC", () => {
		expect(transformModifiedText("x", { ctrl: false, alt: true })).toBe("\u001bx");
		expect(transformModifiedText("c", { ctrl: true, alt: true })).toBe("\u001b\u0003");
		expect(transformModifiedText("", { ctrl: true, alt: true })).toBe("");
	});

	test("soft-keyboard text goes through the sticky modifiers once", () => {
		const terminal = makeTerminal();
		const forwarded: Uint8Array[] = [];
		const sticky = new StickyModifiers();
		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes), { sticky });

		sticky.tap("ctrl");
		terminal.input("c");
		expect(forwarded.map(text)).toEqual(["\u0003"]);
		expect(sticky.snapshot.ctrl).toBe("off");

		sticky.tap("alt");
		sticky.tap("alt");
		terminal.input("x");
		terminal.input("y");
		expect(forwarded.map(text)).toEqual(["\u0003", "\u001bx", "\u001by"]);
		subscription.dispose();
	});
});

describe("pressExtraKey", () => {
	test("dispatches a keyboard event so xterm sends the mode-correct sequence", async () => {
		const { terminal } = openTerminal();
		const forwarded: Uint8Array[] = [];
		const sticky = new StickyModifiers();
		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes), { sticky });

		const up = EXTRA_KEYS.find((key) => key.id === "up");
		const home = EXTRA_KEYS.find((key) => key.id === "home");
		if (!up || !home) throw new Error("missing extra keys");
		pressExtraKey(terminal, up, sticky);
		expect(forwarded.map(text)).toEqual(["\u001b[A"]);

		await write(terminal, "\u001b[?1h");
		pressExtraKey(terminal, up, sticky);
		pressExtraKey(terminal, home, sticky);
		expect(forwarded.map(text).slice(1)).toEqual(["\u001bOA", "\u001bOH"]);

		// Ctrl applies to the next key only and xterm generates the modified sequence.
		sticky.tap("ctrl");
		expect(sticky.snapshot.ctrl).toBe("once");
		pressExtraKey(terminal, up, sticky);
		expect(forwarded.map(text).at(-1)).toBe("\u001b[1;5A");
		expect(sticky.snapshot.ctrl).toBe("off");
		subscription.dispose();
	});

	test("prints the punctuation keys through xterm", () => {
		const { terminal } = openTerminal();
		const forwarded: Uint8Array[] = [];
		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes));
		for (const id of ["pipe", "tilde", "slash", "dash"]) {
			const key = EXTRA_KEYS.find((entry) => entry.id === id);
			if (!key) throw new Error(`missing ${id}`);
			pressExtraKey(terminal, key, new StickyModifiers());
		}
		expect(forwarded.map(text)).toEqual(["|", "~", "/", "-"]);
		subscription.dispose();
	});
});

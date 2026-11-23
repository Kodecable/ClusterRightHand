import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { forwardUserInput } from "./user-input";

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
		const terminal = makeTerminal();
		const forwarded: Uint8Array[] = [];
		const subscription = forwardUserInput(terminal, (bytes) => forwarded.push(bytes));

		// Normal mouse tracking without SGR: xterm.js encodes these reports in the default (X10)
		// encoding and emits them through `onBinary`, never through `onData`.
		await write(terminal, "\u001b[?1000h");
		expect(terminal.modes.mouseTrackingMode).toBe("vt200");

		// There is no public way to emit a binary event; drive the core's event directly. The report
		// includes bytes above 127, which must stay one byte each (latin-1, not UTF-8).
		const core = (
			terminal as unknown as {
				_core: { coreService: { triggerBinaryEvent(data: string): void } };
			}
		)._core;
		const report = `\u001b[M${String.fromCharCode(32, 133, 201)}`;
		core.coreService.triggerBinaryEvent(report);

		expect(forwarded).toHaveLength(1);
		expect(Array.from(forwarded[0] ?? [])).toEqual([27, 91, 77, 32, 133, 201]);
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

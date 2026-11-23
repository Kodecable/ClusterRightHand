/**
 * The headless terminal screen's own contract (doc/design/pty.md "crhs", "Agent tools"): the OSC title
 * the program sets (sanitized, untrusted), the modes ajoining viewer's snapshot must keep, and the
 * named keys whose bytes depend on the terminal's application-cursor-keys mode.
 */
import { describe, expect, it } from "vitest";
import { sanitizeTerminalTitle, TerminalScreen } from "../src/terminals/emulator.ts";
import { keysToBytes } from "../src/terminals/tools.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function write(screen: TerminalScreen, text: string): Promise<void> {
	screen.write(encoder.encode(text));
	await screen.whenIdle();
}

describe("TerminalScreen", () => {
	it("keeps the program's OSC title sanitized: no control characters, folded whitespace, at most 256", async () => {
		expect(sanitizeTerminalTitle("\u0001Build\u0002  log\n\t ready  ")).toBe("Build log ready");
		expect(sanitizeTerminalTitle("x".repeat(300))).toHaveLength(256);

		const screen = new TerminalScreen(24, 80);
		const seen: string[] = [];
		screen.onTitleChange((title) => seen.push(title));
		await write(screen, "\u001b]0;  Build   log ready  \u0007");

		expect(seen).toEqual(["Build log ready"]);
		expect(screen.title).toBe("Build log ready");

		await write(screen, `\u001b]2;${"x".repeat(300)}\u0007`);
		expect(screen.title).toHaveLength(256);
		expect(screen.title).toBe("x".repeat(256));
		screen.dispose();
	});

	it("keeps application cursor keys in a joining viewer's snapshot", async () => {
		const screen = new TerminalScreen(24, 80);
		await write(screen, "prompt$ \u001b[?1h");
		const snapshot = await screen.snapshot();
		expect(snapshot).toContain("\u001b[?1h");
		screen.dispose();
	});
});

describe("keysToBytes", () => {
	it("uses the normal cursor sequences in normal mode", () => {
		expect(decoder.decode(keysToBytes(["Up", "Down", "Left", "Right", "Home", "End"]))).toBe(
			"\u001b[A\u001b[B\u001b[D\u001b[C\u001b[H\u001b[F",
		);
	});

	it("uses SS3 cursor and Home/End sequences in application cursor keys mode", () => {
		expect(decoder.decode(keysToBytes(["Up", "Down", "Left", "Right", "Home", "End"], true))).toBe(
			"\u001bOA\u001bOB\u001bOD\u001bOC\u001bOH\u001bOF",
		);
		// Other keys are unchanged by the mode.
		expect(decoder.decode(keysToBytes(["Enter", "PageUp", "ctrl-c"], true))).toBe("\r\u001b[5~\u0003");
	});
});

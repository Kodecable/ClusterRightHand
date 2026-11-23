/**
 * The headless screen of one terminal (doc/design/pty.md "crhs"): `@xterm/headless` parses the raw
 * output so a joining viewer gets the current screen at once, the agent tools get a text snapshot,
 * and a BEL is seen by the parser (an OSC terminator's BEL therefore never rings it).
 *
 * Alongside the parser the module keeps a bounded escape-stripped log of the output. `pty_read
 * output` and `pty_watch` work on that log, so matching is plain text and a keyword split between
 * two chunks still matches. While the parser is on the alternate screen (a full-screen program),
 * its output is not logged: the alternate screen is the program's current picture, not output to
 * read back (doc/design/pty.md "Agent tools").
 */
import { createRequire } from "node:module";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Terminal as TerminalType } from "@xterm/headless";

// Both packages are CommonJS: Node's ESM loader cannot see their named exports, so they are loaded
// through a require and typed from their declaration files.
const require = createRequire(import.meta.url);
const { SerializeAddon } = require("@xterm/addon-serialize") as { SerializeAddon: new () => SerializeAddonType };
const { Terminal } = require("@xterm/headless") as { Terminal: typeof TerminalType };

/** The escape-stripped text kept for reads and watches, in characters. */
export const TEXT_LOG_CHARS = 256 * 1024;
/** The most screen text one read returns. */
export const SCREEN_TEXT_CHARS = 20_000;
/** The most characters of a program-set title kept (doc/design/pty.md "The terminal object"). */
export const TITLE_MAX_CHARS = 256;

/**
 * The title a program set through OSC 0/2 is untrusted text: control characters are removed, runs
 * of whitespace fold into one space, and only the first {@link TITLE_MAX_CHARS} characters stay.
 */
export function sanitizeTerminalTitle(title: string): string {
	let text = "";
	for (const character of title) {
		const code = character.codePointAt(0) ?? 0;
		// C0 controls other than whitespace, DEL, and the C1 controls: stripped, never rendered.
		const control =
			(code >= 0 && code <= 8) ||
			code === 11 ||
			code === 12 ||
			(code >= 14 && code <= 31) ||
			(code >= 127 && code <= 159);
		if (!control) text += character;
	}
	return text.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS).trimEnd();
}

/** What `pty_read screen` returns: the visible screen and the cursor within it. */
export interface ScreenSnapshot {
	text: string;
	cursor: { row: number; col: number };
	rows: number;
	cols: number;
}

/**
 * Strips ANSI escape sequences incrementally. The state survives across chunks, so a sequence split
 * between two writes never leaks into the text. BEL, C0 controls and control characters that are
 * not part of a sequence are kept; a terminal reads them as text is not the case, but the caller
 * only searches and displays the result.
 */
class EscapeStripper {
	#state: "ground" | "esc" | "csi" | "osc" | "string" | "string-esc" = "ground";

	strip(input: string): string {
		let out = "";
		for (const ch of input) {
			switch (this.#state) {
				case "ground":
					if (ch === "\u001b") this.#state = "esc";
					else out += ch;
					break;
				case "esc":
					if (ch === "[") this.#state = "csi";
					else if (ch === "]") this.#state = "osc";
					else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") this.#state = "string";
					else if (ch === "\u001b") this.#state = "esc";
					else this.#state = "ground";
					break;
				case "csi":
					// Parameters and intermediates, then one final byte in @..~.
					if (ch >= "@" && ch <= "~") this.#state = "ground";
					else if (ch === "\u001b") this.#state = "esc";
					break;
				case "osc":
					// OSC ends with BEL or ST (ESC \). Its BEL is a terminator, not a bell.
					if (ch === "\u0007" || ch === "\u001b") this.#state = ch === "\u0007" ? "ground" : "string-esc";
					break;
				case "string":
					if (ch === "\u001b") this.#state = "string-esc";
					break;
				case "string-esc":
					this.#state = ch === "\\" ? "ground" : ch === "\u001b" ? "string-esc" : "string";
					break;
			}
		}
		return out;
	}
}

/**
 * One terminal's screen state. Writes are applied in order; `whenIdle` waits for the parser, so a
 * snapshot taken after a read includes every byte the caller saw.
 */
export class TerminalScreen {
	readonly #terminal: TerminalType;
	readonly #serializer: SerializeAddonType = new SerializeAddon();
	/** Absolute offset (characters) of the oldest text still in the log. */
	#logStart = 0;
	#log = "";
	#stripper = new EscapeStripper();
	#bell = 0;
	#title = "";
	readonly #bellListeners = new Set<() => void>();
	readonly #dataListeners = new Set<(data: string) => void>();
	readonly #alternateListeners = new Set<(alternate: boolean, screenText: string) => void>();
	readonly #titleListeners = new Set<(title: string) => void>();
	/** Whether the parser is on the alternate screen; kept from the buffer's own change event. */
	#alternate = false;
	/** A buffer switch happened while the current write was being parsed. */
	#bufferChanged = false;
	#writes: Promise<void> = Promise.resolve();
	#disposed = false;

	constructor(rows: number, cols: number) {
		this.#terminal = new Terminal({
			cols,
			rows,
			scrollback: 1000,
			allowProposedApi: true,
			// The terminal's own size is the only size; a viewer adopts it and never changes it by
			// attaching (doc/design/pty.md "Size").
			convertEol: false,
		});
		this.#terminal.onBell(() => {
			this.#bell++;
			for (const listener of this.#bellListeners) listener();
		});
		// A program's OSC 0/2 title is untrusted text; it is kept sanitized and never replaces a
		// trusted label (doc/design/pty.md "The terminal object").
		this.#terminal.onTitleChange((title) => {
			const clean = sanitizeTerminalTitle(title);
			if (clean === this.#title) return;
			this.#title = clean;
			for (const listener of this.#titleListeners) listener(clean);
		});
		// The parser's answers to terminal queries (cursor position reports, device attributes, …)
		// are the terminal's input (doc/design/pty.md "crhs"). crhs is the single responder: a viewer
		// forwards only user input.
		this.#terminal.onData((data) => {
			for (const listener of this.#dataListeners) listener(data);
		});
		// The alternate screen is the parser's own state, and this is its own change event: no
		// escape sequence is parsed here (doc/design/pty.md "Agent tools").
		this.#terminal.buffer.onBufferChange((buffer) => {
			this.#bufferChanged = true;
			const alternate = buffer.type === "alternate";
			if (alternate === this.#alternate) return;
			this.#alternate = alternate;
			const text = this.screenTextNow();
			for (const listener of this.#alternateListeners) listener(alternate, text);
		});
		this.#terminal.loadAddon(this.#serializer);
	}

	get terminal(): TerminalType {
		return this.#terminal;
	}

	/**
	 * Feeds raw output: the parser sees it, and the stripped log keeps it only when it was written
	 * outside the alternate screen. A write that enters or leaves the alternate screen is dropped
	 * whole: without parsing escapes it cannot be split, and a full-screen program's drawing must
	 * never reach the log.
	 */
	write(data: Uint8Array): void {
		if (this.#disposed) return;
		const text = new TextDecoder().decode(data);
		this.#writes = this.#writes.then(
			() =>
				new Promise<void>((resolve) => {
					if (this.#disposed) return resolve();
					const wasAlternate = this.#alternate;
					this.#bufferChanged = false;
					this.#terminal.write(data, () => {
						if (!wasAlternate && !this.#alternate && !this.#bufferChanged) this.#append(text);
						resolve();
					});
				}),
		);
	}

	/** Resolves once every write issued so far has been parsed. */
	async whenIdle(): Promise<void> {
		await this.#writes;
	}

	/** The parser's BEL count; a BEL that ends an OSC sequence does not increase it. */
	get bellCount(): number {
		return this.#bell;
	}

	/** Calls `listener` on every BEL the parser sees on its own. */
	onBell(listener: () => void): () => void {
		this.#bellListeners.add(listener);
		return () => this.#bellListeners.delete(listener);
	}

	/** Calls `listener` with every answer the parser emits to a terminal query, in parse order. */
	onData(listener: (data: string) => void): () => void {
		this.#dataListeners.add(listener);
		return () => this.#dataListeners.delete(listener);
	}

	/** The program's current title, already sanitized; empty until it sets one. */
	get title(): string {
		return this.#title;
	}

	/** Calls `listener` when the program sets a different OSC 0/2 title. */
	onTitleChange(listener: (title: string) => void): () => void {
		this.#titleListeners.add(listener);
		return () => this.#titleListeners.delete(listener);
	}

	/** Whether a full-screen program is using the alternate screen right now. */
	get alternate(): boolean {
		return this.#alternate;
	}

	/**
	 * Calls `listener` when the active buffer changes, with the screen text at that moment: the
	 * blank alternate screen on entry, the restored normal screen on return. `pty_watch` uses the
	 * entry snapshot as its baseline for alternate-screen keywords.
	 */
	onAlternateChange(listener: (alternate: boolean, screenText: string) => void): () => void {
		this.#alternateListeners.add(listener);
		return () => this.#alternateListeners.delete(listener);
	}

	/**
	 * The visible screen as text right now, without waiting for pending writes. The synchronous
	 * form is for the buffer change event, which fires in the middle of parsing.
	 */
	screenTextNow(): string {
		if (this.#disposed) return "";
		return this.#visibleText();
	}

	/** The escape-stripped text written since absolute offset `offset`, capped. */
	textSince(offset: number): { text: string; next: number; lost: boolean } {
		const from = Math.max(offset, this.#logStart);
		const start = Math.max(0, from - this.#logStart);
		const text = this.#log.slice(start);
		return { text, next: this.#logStart + this.#log.length, lost: from > offset };
	}

	/** The absolute offset the log starts at; a reader cursor behind it lost output. */
	get logStart(): number {
		return this.#logStart;
	}

	/** The absolute offset just past the newest stripped output. */
	get logEnd(): number {
		return this.#logStart + this.#log.length;
	}

	/** The visible screen as text, trailing blank lines removed, with the cursor in it. */
	async screen(): Promise<ScreenSnapshot> {
		await this.whenIdle();
		const buffer = this.#terminal.buffer.active;
		const top = buffer.viewportY;
		return {
			text: this.#visibleText(),
			cursor: { row: Math.max(0, buffer.cursorY - top), col: buffer.cursorX },
			rows: this.#terminal.rows,
			cols: this.#terminal.cols,
		};
	}

	/**
	 * The whole scrollback and current screen serialized as ANSI, for a joining viewer. The terminal
	 * modes are included: a program that enabled application cursor keys must not be read as normal
	 * mode by the joining viewer, whose arrows would otherwise be the wrong sequence.
	 */
	async snapshot(): Promise<string> {
		await this.whenIdle();
		return this.#serializer.serialize({ scrollback: 1000, excludeModes: false, excludeAltBuffer: false });
	}

	/** Applies a size change; the parser keeps its content and reflows it. */
	resize(rows: number, cols: number): void {
		if (this.#disposed) return;
		this.#terminal.resize(cols, rows);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#bellListeners.clear();
		this.#dataListeners.clear();
		this.#alternateListeners.clear();
		this.#titleListeners.clear();
		this.#terminal.dispose();
	}

	#visibleText(): string {
		const buffer = this.#terminal.buffer.active;
		const top = buffer.viewportY;
		const lines: string[] = [];
		for (let row = 0; row < this.#terminal.rows; row++) {
			const line = buffer.getLine(top + row);
			lines.push((line?.translateToString(true) ?? "").replace(/\s+$/, ""));
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		let text = lines.join("\n");
		if (text.length > SCREEN_TEXT_CHARS) text = text.slice(0, SCREEN_TEXT_CHARS);
		return text;
	}

	#append(text: string): void {
		const stripped = this.#stripper.strip(text);
		if (stripped === "") return;
		this.#log += stripped;
		const over = this.#log.length - TEXT_LOG_CHARS;
		if (over > 0) {
			this.#log = this.#log.slice(over);
			this.#logStart += over;
		}
	}
}

import type { GrammarState, HighlighterGeneric, ThemedToken } from "shiki";
import { type LangKey, THEME_NAMES } from "./highlighter";

export interface TokenSnapshot {
	/** Tokenised, immutable complete lines (appended to, never rewritten). */
	lines: ThemedToken[][];
	/** Tokens for the trailing line that is still being typed (re-tokenised). */
	partial: ThemedToken[] | null;
	partialText: string;
	/** CSS custom properties for the <pre> background of both themes. */
	preStyle: Record<string, string> | undefined;
}

const EMPTY: TokenSnapshot = { lines: [], partial: null, partialText: "", preStyle: undefined };

function themeBackgrounds(highlighter: HighlighterGeneric<string, string>): Record<string, string> | undefined {
	try {
		const light = highlighter.getTheme(THEME_NAMES.light);
		const dark = highlighter.getTheme(THEME_NAMES.dark);
		return {
			"--shiki-light-bg": light.bg ?? "transparent",
			"--shiki-dark-bg": dark.bg ?? "transparent",
		};
	} catch {
		return undefined;
	}
}

/**
 * Incremental tokenizer for one code block.
 *
 * Only *finished* lines (terminated by `\n`) are tokenized, and each batch
 * continues from the grammar state left by the previous batch, so a block that
 * grows one character at a time never re-tokenizes its prefix. The trailing
 * (incomplete) line is re-tokenized on every update from that same state.
 *
 * `update()` is deliberately idempotent for a given `code`: React may call it
 * twice for the same render without corrupting the incremental buffers.
 */
export class IncrementalTokenizer {
	private readonly preStyle: Record<string, string> | undefined;
	private code = "";
	private placed = 0;
	private lines: ThemedToken[][] = [];
	private state: GrammarState | undefined;
	private partialText = "\u0000";
	private partial: ThemedToken[] | null = null;
	private snapshot: TokenSnapshot = EMPTY;

	private readonly highlighter: HighlighterGeneric<string, string>;
	private readonly lang: LangKey;

	constructor(highlighter: HighlighterGeneric<string, string>, lang: LangKey) {
		this.highlighter = highlighter;
		this.lang = lang;
		this.preStyle = themeBackgrounds(highlighter);
	}

	update(code: string): TokenSnapshot {
		if (code === this.code) return this.snapshot;

		if (!code.startsWith(this.code)) {
			// Text was replaced (not appended to) — rebuild from scratch.
			this.lines = [];
			this.placed = 0;
			this.state = undefined;
			this.partialText = "\u0000";
			this.partial = null;
		}
		this.code = code;

		const rows = code.split("\n");
		// `rows.length - 1` is the number of newline-terminated (complete) lines,
		// including the empty ones produced by blank lines and trailing newlines.
		const complete = rows.length - 1;

		if (complete > this.placed) {
			const chunk = rows.slice(this.placed, complete).join("\n");
			const expected = complete - this.placed;
			try {
				const result = this.highlighter.codeToTokens(chunk, {
					lang: this.lang,
					themes: { light: THEME_NAMES.light, dark: THEME_NAMES.dark },
					defaultColor: false,
					grammarState: this.state,
				});
				const produced = result.tokens;
				for (let i = 0; i < expected; i += 1) {
					this.lines.push(produced[i] ?? []);
				}
				this.state = result.grammarState ?? this.state;
				this.placed = complete;
			} catch (error) {
				console.error("[shiki] tokenize failed, falling back to plain text", error);
				for (let i = 0; i < expected; i += 1) this.lines.push([]);
				this.placed = complete;
				this.state = undefined;
			}
		}

		const partialText = rows.slice(complete).join("\n");
		if (partialText !== this.partialText) {
			this.partialText = partialText;
			if (partialText.length === 0) {
				this.partial = null;
			} else {
				try {
					const result = this.highlighter.codeToTokens(partialText, {
						lang: this.lang,
						themes: { light: THEME_NAMES.light, dark: THEME_NAMES.dark },
						defaultColor: false,
						grammarState: this.state,
					});
					this.partial = result.tokens[0] ?? [];
				} catch {
					this.partial = null;
				}
			}
		}

		this.snapshot = {
			lines: this.lines,
			partial: this.partial,
			partialText: this.partialText,
			preStyle: this.preStyle,
		};
		return this.snapshot;
	}
}

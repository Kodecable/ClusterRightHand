import { Lexer, type Token } from "marked";

/**
 * Incremental block splitting for streaming Markdown
 * (doc/design/webui.md "SafeMarkdown" items 1, 2 and 5).
 *
 * Markdown renders block by block — `react-markdown` is mounted once per
 * top-level block — so only the last (growing) block is re-parsed. This module
 * owns the splitter and its memoisation:
 *
 *  - finished blocks are kept as they are: an update re-lexes only from the
 *    start of the previous last block;
 *  - the last block's fenced code is flagged so the renderer can skip Markdown
 *    and feed the incremental highlighter directly;
 *  - reference definitions are collected across blocks so a definition at the
 *    end of the message resolves links that appear above it.
 */

export interface MarkdownBlock {
	source: string;
	/** A fenced code block that the renderer can hand to the highlighter directly. */
	code?: { text: string; lang: string | undefined };
	/** The reference-definition source lines this block contains. */
	definitions: string;
}

export interface SplitResult {
	blocks: MarkdownBlock[];
	/** All reference definitions in the document, one per line. */
	definitions: string;
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** A fenced code block's content and language, or undefined when the token is not fenced. */
export function fencedCodeOf(token: Token): { text: string; lang: string | undefined } | undefined {
	if (token.type !== "code") return undefined;
	const typed = token as { raw: string; text: string; lang?: string; codeBlockStyle?: string };
	if (typed.codeBlockStyle === "indented") return undefined;
	if (!FENCE_RE.test(typed.raw.split("\n")[0] ?? "")) return undefined;
	return { text: typed.text ?? "", lang: typed.lang };
}

function blockOf(token: Token): MarkdownBlock {
	const def = token.type === "def" ? ((token as { raw: string }).raw ?? "") : "";
	const code = fencedCodeOf(token);
	return {
		source: token.raw,
		...(code ? { code } : {}),
		definitions: def,
	};
}

function definitionsOf(blocks: readonly MarkdownBlock[]): string {
	return blocks
		.map((block) => block.definitions)
		.filter((definition) => definition !== "")
		.join("\n");
}

/** Split a complete document. Used by the one-shot render and by tests. */
export function splitMarkdownBlocks(text: string): SplitResult {
	if (text.length === 0) return { blocks: [], definitions: "" };
	try {
		const tokens = Lexer.lex(text, { gfm: true });
		const blocks: MarkdownBlock[] = [];
		let total = 0;
		for (const token of tokens) {
			const raw = token.raw;
			if (typeof raw !== "string" || raw.length === 0) continue;
			blocks.push(blockOf(token));
			total += raw.length;
		}
		// Cheap guard against lexer normalisation: if the blocks do not add up to
		// the original document, render it as one block rather than lose text.
		if (blocks.length === 0 || total !== text.length) {
			return { blocks: [{ source: text, definitions: "" }], definitions: "" };
		}
		return { blocks, definitions: definitionsOf(blocks) };
	} catch {
		return { blocks: [{ source: text, definitions: "" }], definitions: "" };
	}
}

/** All reference definitions of a document, in order. */
export function collectReferenceDefinitions(text: string): string[] {
	return splitMarkdownBlocks(text)
		.definitions.split("\n")
		.filter((line) => line.trim() !== "");
}

const EMPTY: SplitResult = { blocks: [], definitions: "" };

/**
 * Stateful splitter. Keep one instance per rendered message; call `update` with
 * the accumulated text on every render.
 */
export class MarkdownSplitter {
	private text = "\u0000";
	private streaming: boolean | null = null;
	private result: SplitResult = EMPTY;
	private stable: MarkdownBlock[] = [];
	private prefix = "";

	reset(): void {
		this.text = "\u0000";
		this.streaming = null;
		this.result = EMPTY;
		this.stable = [];
		this.prefix = "";
	}

	update(text: string, streaming: boolean): SplitResult {
		if (text === this.text && streaming === this.streaming) return this.result;
		this.text = text;
		this.streaming = streaming;

		if (text.length === 0) {
			this.stable = [];
			this.prefix = "";
			this.result = EMPTY;
			return EMPTY;
		}

		// Text can be replaced (a retry, a new message, an edit), not only
		// appended to. In that case the memoised prefix is invalid.
		if (!text.startsWith(this.prefix)) {
			this.stable = [];
			this.prefix = "";
		}

		const rest = text.slice(this.prefix.length);
		let fresh: MarkdownBlock[];
		try {
			const tokens = Lexer.lex(rest, { gfm: true });
			fresh = [];
			let total = 0;
			for (const token of tokens) {
				const raw = token.raw;
				if (typeof raw !== "string" || raw.length === 0) continue;
				fresh.push(blockOf(token));
				total += raw.length;
			}
			if (fresh.length === 0 || total !== rest.length) return this.fallback(text, streaming);
		} catch {
			return this.fallback(text, streaming);
		}

		const blocks = [...this.stable, ...fresh];
		// While streaming, the last *content* block can still grow — and a blank
		// line is part of the document, not a block boundary: a list can merge
		// across it into the same token. Everything before the last non-blank
		// block is final and never re-lexed again. A finished document keeps all.
		let lastContent = -1;
		for (let i = blocks.length - 1; i >= 0; i -= 1) {
			if ((blocks[i]?.source ?? "").trim() !== "") {
				lastContent = i;
				break;
			}
		}
		const stableCount = streaming ? Math.max(0, lastContent) : blocks.length;
		this.stable = blocks.slice(0, stableCount);
		this.prefix = this.stable.map((block) => block.source).join("");
		this.result = { blocks, definitions: definitionsOf(blocks) };
		return this.result;
	}

	private fallback(text: string, streaming: boolean): SplitResult {
		this.stable = [];
		this.prefix = "";
		const result = splitMarkdownBlocks(text);
		this.result = result;
		if (!streaming) {
			this.stable = result.blocks;
			this.prefix = result.blocks.map((block) => block.source).join("");
		}
		return result;
	}
}

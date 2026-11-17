import { Lexer, type Token } from "marked";

/**
 * Incremental block splitting for streaming Markdown
 * (doc/design/webui.md "SafeMarkdown").
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
 *    end of the message resolves links that appear above it;
 *  - footnote definitions are collected the same way;
 *  - a display `$$` formula may contain blank lines, so the tokens `marked`
 *    split it into are merged while a closing fence exists; in a finished
 *    document an opener that never closes is ordinary Markdown, while only the
 *    last block of a stream in flight is shown as source.
 */

export interface MarkdownBlock {
	source: string;
	/** A fenced code block that the renderer can hand to the highlighter directly. */
	code?: { text: string; lang: string | undefined };
	/** The reference-definition source lines this block contains. */
	definitions: string;
	/** The footnote-definition source lines this block contains; such a block is collected, not rendered in place. */
	footnotes: string;
	/** A display `$$` that has not closed yet (a stream in flight): its source is shown, not rendered as math. */
	unclosedMath?: boolean;
}

export interface SplitResult {
	blocks: MarkdownBlock[];
	/** All reference definitions in the document, one per line. */
	definitions: string;
	/** All footnote definitions in the document, in order. */
	footnotes: string;
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FOOTNOTE_DEFINITION_RE = /^ {0,3}\[\^[^\]\s]+\]:/;
const DISPLAY_MATH_OPEN_RE = /^ {0,3}\$\$/;
const DISPLAY_MATH_CLOSE_RE = /\$\$\s*$/;

/** A fenced code block's content and language, or undefined when the token is not fenced. */
export function fencedCodeOf(token: Token): { text: string; lang: string | undefined } | undefined {
	if (token.type !== "code") return undefined;
	const typed = token as { raw: string; text: string; lang?: string; codeBlockStyle?: string };
	if (typed.codeBlockStyle === "indented") return undefined;
	if (!FENCE_RE.test(typed.raw.split("\n")[0] ?? "")) return undefined;
	return { text: typed.text ?? "", lang: typed.lang };
}

/**
 * The source when it is a footnote definition, else "". `marked` has no footnote token, so
 * `[^label]:` arrives either as an ordinary paragraph or as a `def` token (when the body happens to
 * look like a reference destination, e.g. `[^NOTE]: Body`). The renderer collects it and prepends it
 * to every block so references resolve (doc/design/webui.md "SafeMarkdown"). remark-gfm treats the
 * whole paragraph that starts with a definition as definition content, so collecting all of it
 * matches it.
 */
function footnoteDefinitionsOf(token: Token): string {
	if (token.type !== "paragraph" && token.type !== "def") return "";
	const raw = (token as { raw?: string }).raw ?? "";
	if (!FOOTNOTE_DEFINITION_RE.test(raw)) return "";
	return raw;
}

function blockOf(token: Token): MarkdownBlock {
	const raw = (token as { raw?: string }).raw ?? "";
	const footnotes = footnoteDefinitionsOf(token);
	const def = token.type === "def" && footnotes === "" ? raw : "";
	const code = fencedCodeOf(token);
	return {
		source: token.raw,
		...(code ? { code } : {}),
		definitions: def,
		footnotes,
	};
}

function definitionsOf(blocks: readonly MarkdownBlock[]): string {
	return blocks
		.map((block) => block.definitions)
		.filter((definition) => definition !== "")
		.join("\n");
}

function footnotesOf(blocks: readonly MarkdownBlock[]): string {
	return blocks
		.map((block) => block.footnotes)
		.filter((footnote) => footnote !== "")
		.join("\n");
}

/**
 * The offset of the first display-math opener in `source` that has no closer, or null.
 *
 * A display opener is a line that starts with `$$` (after up to three spaces) and has no second
 * `$$` on that line — an inline `$$…$$` pair is not a display formula. Its closer is the next line
 * that ends with `$$` (trailing whitespace allowed). Scanning line by line matters: a `$$` that
 * closes one formula must not also count as the opener of the next, or an inline `$$…$$` on a line
 * beginning with a closing `$$` would be misread.
 */
function unclosedDisplayMath(source: string): number | null {
	let open: number | null = null;
	let offset = 0;
	while (offset <= source.length) {
		const newline = source.indexOf("\n", offset);
		const end = newline === -1 ? source.length : newline;
		const line = source.slice(offset, end);
		if (open === null) {
			const opener = DISPLAY_MATH_OPEN_RE.exec(line);
			if (opener !== null && !line.slice(opener[0].length).includes("$$")) open = offset;
		} else if (DISPLAY_MATH_CLOSE_RE.test(line)) {
			open = null;
		}
		if (newline === -1) break;
		offset = newline + 1;
	}
	return open;
}

/**
 * Lexed tokens as render blocks. A display formula may contain blank lines, so the tokens `marked`
 * split it into are merged until its closing `$$`. A finished document has no formula after an
 * opener that never closes: such a token is ordinary Markdown (merging would swallow the rest of
 * the message). A stream in flight is different — the open formula is its last block, so it merges
 * to the end and is flagged for source display.
 */
function rawBlocks(tokens: readonly Token[], streaming: boolean): { blocks: MarkdownBlock[]; total: number } {
	const blocks: MarkdownBlock[] = [];
	let total = 0;
	for (let index = 0; index < tokens.length; ) {
		const token = tokens[index];
		if (token === undefined) break;
		index += 1;
		const raw = token.raw;
		if (typeof raw !== "string" || raw.length === 0) continue;
		total += raw.length;
		const nextIndex = index;
		let source = raw;
		let unclosed = token.type === "paragraph" ? unclosedDisplayMath(source) : null;
		if (unclosed !== null) {
			let combined = source;
			let combinedTotal = total;
			let closed = false;
			while (index < tokens.length) {
				const next = tokens[index];
				if (next === undefined) break;
				index += 1;
				const nextRaw = typeof next.raw === "string" ? next.raw : "";
				combined += nextRaw;
				combinedTotal += nextRaw.length;
				if (unclosedDisplayMath(combined) === null) {
					closed = true;
					break;
				}
			}
			if (closed || streaming) {
				source = combined;
				total = combinedTotal;
				if (closed) unclosed = null;
			} else {
				// The formula never closes and this is not a stream: render the token as Markdown.
				index = nextIndex;
				unclosed = null;
			}
		}
		blocks.push(
			source === raw && unclosed === null
				? blockOf(token)
				: { source, definitions: "", footnotes: "", ...(unclosed === null ? {} : { unclosedMath: true }) },
		);
	}
	return { blocks, total };
}

/** Split a complete document. Used by the one-shot render and by tests. */
export function splitMarkdownBlocks(text: string): SplitResult {
	if (text.length === 0) return { blocks: [], definitions: "", footnotes: "" };
	try {
		const tokens = Lexer.lex(text, { gfm: true });
		const { blocks, total } = rawBlocks(tokens, false);
		// Cheap guard against lexer normalisation: if the blocks do not add up to
		// the original document, render it as one block rather than lose text.
		if (blocks.length === 0 || total !== text.length) {
			return { blocks: [{ source: text, definitions: "", footnotes: "" }], definitions: "", footnotes: "" };
		}
		const footnotes = footnotesOf(blocks);
		return { blocks, definitions: definitionsOf(blocks), footnotes };
	} catch {
		return { blocks: [{ source: text, definitions: "", footnotes: "" }], definitions: "", footnotes: "" };
	}
}

/** All reference definitions of a document, in order. */
export function collectReferenceDefinitions(text: string): string[] {
	return splitMarkdownBlocks(text)
		.definitions.split("\n")
		.filter((line) => line.trim() !== "");
}

const EMPTY: SplitResult = { blocks: [], definitions: "", footnotes: "" };

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
			const lexed = rawBlocks(tokens, streaming);
			fresh = lexed.blocks;
			if (fresh.length === 0 || lexed.total !== rest.length) return this.fallback(text, streaming);
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
		this.result = { blocks, definitions: definitionsOf(blocks), footnotes: footnotesOf(blocks) };
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

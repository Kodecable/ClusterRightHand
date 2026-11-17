/**
 * `\(…\)` and `\[…\]` math delimiters for the Markdown renderer
 * (doc/design/webui.md "SafeMarkdown").
 *
 * `remark-math` only knows the dollar forms. Before the text is split into blocks, these TeX-style
 * delimiters are rewritten to `$$…$$` (inline) and a `$$\n…\n$$` display fence, which also lets the
 * splitter keep a multi-line display formula in one block. Code is never touched: fenced blocks and
 * inline code spans are copied verbatim, including the delimiters they contain.
 *
 * `\[…\]` is display math only when it forms a block of its own: the opener starts a line (after up
 * to three spaces of indentation) and the closer ends a line (trailing spaces allowed). Anything
 * else is ordinary Markdown — most importantly `\[link\]` mid-sentence is the escaped literal
 * `[link]`, and rewriting it would break the paragraph.
 */

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/** Whether `index` is the first character of its line. */
function atLineStart(text: string, index: number): boolean {
	return index === 0 || text[index - 1] === "\n";
}

/** The number of consecutive `character` bytes starting at `index`. */
function runLength(text: string, index: number, character: string): number {
	let length = 0;
	while (text[index + length] === character) length += 1;
	return length;
}

/** The end index (exclusive) of a code span opened at `open` with a backtick run of `length`, or -1. */
function codeSpanEnd(text: string, open: number, length: number): number {
	let index = open + length;
	while (index < text.length) {
		if (text[index] !== "`") {
			index += 1;
			continue;
		}
		const run = runLength(text, index, "`");
		if (run === length) return index + run;
		index += run;
	}
	return -1;
}

/**
 * The index of the backslash of an unescaped `\)` or `\]` at or after `from`, or -1. A backslash is
 * escaped when it closes an even-length run of backslashes.
 */
function mathClose(text: string, from: number, close: string): number {
	let index = from;
	while (index < text.length - 1) {
		if (text[index] === "\\" && text[index + 1] === close && backslashRunAt(text, index) % 2 === 1) return index;
		index += 1;
	}
	return -1;
}

/** The number of consecutive backslashes ending at `index` (inclusive), used for escape detection. */
function backslashRunAt(text: string, index: number): number {
	let start = index;
	while (start - 1 >= 0 && text[start - 1] === "\\") start -= 1;
	return index - start + 1;
}

/** The index of the first character of the line containing `index`. */
function lineStartOf(text: string, index: number): number {
	const newline = text.lastIndexOf("\n", index - 1);
	return newline === -1 ? 0 : newline + 1;
}

/**
 * Whether the `\[` at `index` opens a display formula: it must be unescaped and start its line
 * after at most three spaces of indentation. A list or blockquote prefix is not accepted.
 */
function isDisplayMathOpen(text: string, index: number): boolean {
	if (backslashRunAt(text, index) % 2 === 0) return false;
	return /^ {0,3}$/.test(text.slice(lineStartOf(text, index), index));
}

/**
 * The index (exclusive) just after the `\]` that closes the display formula opened at `open`, or -1.
 * The closer must end its line; only whitespace may follow it. An escaped `\]` is skipped.
 */
function displayMathClose(text: string, open: number): number {
	let from = open + 2;
	for (;;) {
		const close = mathClose(text, from, "]");
		if (close === -1) return -1;
		const lineEnd = text.indexOf("\n", close);
		const rest = text.slice(close + 2, lineEnd === -1 ? text.length : lineEnd);
		if (/^[ \t\r]*$/.test(rest)) return close + 2;
		from = close + 2;
	}
}

/**
 * The TeX between a display formula's delimiters, indented so it stays in the opener's block. The
 * newline after the opener and the newline plus indentation before the closer belong to the fences;
 * everything else, including the indentation of the content lines, is the formula. Keeping that
 * indentation matters inside a list item: the rewritten fence is indented like the opener, and a
 * content line pulled to column zero would end the item, so the formula (and the rest of the list)
 * would leave the list. When every content line is already indented at least as far as the opener,
 * the lines are kept as written; otherwise all of them are shifted together, which preserves their
 * relative alignment.
 */
function formulaContent(text: string, start: number, end: number, indent: string): string {
	let body = text.slice(start, end);
	if (body.includes("\n")) {
		body = body
			.replace(/^[ \t]*\r?\n/, "")
			.replace(/\r?\n[ \t]*$/, "")
			.replace(/[ \t]+$/, "");
	} else {
		body = body.trim();
	}
	if (indent === "" || body === "") return body;
	const lines = body.split("\n");
	let least = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		if (line.trim() === "") continue;
		least = Math.min(least, /^[ \t]*/.exec(line)?.[0].length ?? 0);
	}
	if (least >= indent.length) return body;
	const shift = " ".repeat(indent.length - least);
	return lines.map((line) => (line.trim() === "" ? line : `${shift}${line}`)).join("\n");
}

/**
 * Rewrites `\(…\)` to `$$…$$` and `\[…\]` to a display `$$` fence. Fenced code blocks and inline code
 * spans are copied unchanged, and an unclosed delimiter (a partial stream) is left as text.
 */
export function convertMathDelimiters(text: string): string {
	if (!text.includes("\\(") && !text.includes("\\[")) return text;
	let output = "";
	let index = 0;
	while (index < text.length) {
		if (atLineStart(text, index)) {
			const lineEnd = text.indexOf("\n", index);
			const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
			const fence = FENCE_RE.exec(line);
			if (fence) {
				const marker = fence[2] as string;
				const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
				let next = lineEnd === -1 ? text.length : lineEnd + 1;
				while (next < text.length) {
					const end = text.indexOf("\n", next);
					const candidate = text.slice(next, end === -1 ? text.length : end);
					next = end === -1 ? text.length : end + 1;
					if (closing.test(candidate)) break;
				}
				output += text.slice(index, next);
				index = next;
				continue;
			}
		}
		const character = text[index] as string;
		if (character === "`") {
			const run = runLength(text, index, "`");
			const end = codeSpanEnd(text, index, run);
			if (end !== -1) {
				output += text.slice(index, end);
				index = end;
			} else {
				output += "`".repeat(run);
				index += run;
			}
			continue;
		}
		if (character === "\\" && (text[index + 1] === "(" || text[index + 1] === "[")) {
			// An even backslash run means this backslash is itself escaped, so the delimiter is literal text.
			if (backslashRunAt(text, index) % 2 === 1) {
				const open = text[index + 1] as string;
				if (open === "(") {
					const close = mathClose(text, index + 2, ")");
					if (close !== -1) {
						const inner = text.slice(index + 2, close).trim();
						output += `$$${inner}$$`;
						index = close + 2;
						continue;
					}
				} else if (isDisplayMathOpen(text, index)) {
					const close = displayMathClose(text, index);
					if (close !== -1) {
						const indent = text.slice(lineStartOf(text, index), index);
						const inner = formulaContent(text, index + 2, close - 2, indent);
						output += `$$\n${inner}\n${indent}$$`;
						index = close;
						continue;
					}
				}
			}
		}
		output += character;
		index += 1;
	}
	return output;
}

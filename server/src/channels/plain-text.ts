/**
 * The characters Telegram's rich Markdown consumes a backslash before (messages.ts `escapeMarkdown`). Before any
 * other character the backslash is shown literally, so the plain text keeps it too.
 */
const BACKSLASH_CONSUMED = /[!#$()*+\-.=>[\]\\_`{|}~]/;

/**
 * Texts are written as Markdown (for Telegram's rich messages), but a plain-text surface (Satori, or Telegram's
 * plain fallback) gets plain text: an inline code span becomes its content, a backslash before a character the
 * rich parser escapes becomes that character, and the two entities `escapeMarkdown` writes become `<` and `&`.
 * Markdown that is not converted still shows as written, and inside a code span everything stays literal.
 */
export function markdownEscapesToText(text: string): string {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const ch = text[index] ?? "";
		const next = text[index + 1] ?? "";
		if (ch === "\\" && BACKSLASH_CONSUMED.test(next)) {
			out += next;
			index += 2;
			continue;
		}
		// A backslash at the end of a line is the hard break the cards use; the plain text keeps the line break.
		if (ch === "\\" && next === "\n") {
			out += "\n";
			index += 2;
			continue;
		}
		if (ch === "&") {
			// Only the entities escapeMarkdown writes; an entity the assistant wrote stays as written.
			if (text.startsWith("&lt;", index)) {
				out += "<";
				index += 4;
				continue;
			}
			if (text.startsWith("&amp;", index)) {
				out += "&";
				index += 5;
				continue;
			}
		}
		if (ch === "`") {
			let length = 1;
			while (text[index + length] === "`") length += 1;
			const fence = "`".repeat(length);
			let close = text.indexOf(fence, index + length);
			// A longer run is not the closing fence of this span.
			while (close !== -1 && (text[close + length] === "`" || text[close - 1] === "`")) {
				close = text.indexOf(fence, close + length);
			}
			if (close === -1) {
				out += fence;
				index += length;
				continue;
			}
			let content = text.slice(index + length, close);
			// CommonMark strips one space on each side of a code span that has both.
			if (content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") content = content.slice(1, -1);
			out += content;
			index = close + length;
			continue;
		}
		out += ch;
		index += 1;
	}
	return out;
}

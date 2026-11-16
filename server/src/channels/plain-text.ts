/**
 * Texts are written as Markdown (for Telegram's rich messages), but a plain-text surface (Satori, or Telegram's plain fallback) gets plain text: an inline code
 * span becomes its content, and a backslash escape becomes the ASCII punctuation it escapes (CommonMark
 * allows a backslash before any ASCII punctuation). Markdown that is not an escape still shows as written.
 */
export function markdownEscapesToText(text: string): string {
	const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
	let out = "";
	let index = 0;
	while (index < text.length) {
		const ch = text[index] ?? "";
		if (ch === "\\" && index + 1 < text.length && punctuation.test(text[index + 1] ?? "")) {
			out += text[index + 1];
			index += 2;
			continue;
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

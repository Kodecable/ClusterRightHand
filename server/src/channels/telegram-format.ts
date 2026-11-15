/**
 * Telegram's text limits, splitting and the neutralization of rich-message button tags
 * (doc/design/channels.md "Messages"). Rich messages take Markdown directly, including raw HTML; the button tags
 * are the one construct that must not come from model output.
 */

/** A plain text message and a draft. */
export const TELEGRAM_PLAIN_TEXT_LIMIT = 4096;
/** A rich message's hard limit; the adapter splits a little earlier. */
export const TELEGRAM_TEXT_LIMIT = 32_768;
const SPLIT_AT = 32_000;

/**
 * Splits Markdown into chunks a platform accepts, preferring paragraph then line boundaries. An open code fence
 * is closed at a chunk's end and reopened in the next, so both halves render as code.
 */
export function splitMarkdown(markdown: string, limit = SPLIT_AT): string[] {
	const text = markdown.replaceAll("\r\n", "\n").trim();
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n\n", limit);
		if (cut < limit / 3) cut = rest.lastIndexOf("\n", limit);
		if (cut < limit / 3) cut = limit;
		let chunk = rest.slice(0, cut).trimEnd();
		rest = rest.slice(cut).trimStart();
		// Keep fences balanced across the split.
		const fences = (chunk.match(/^\s*```/gm) ?? []).length;
		if (fences % 2 === 1) {
			chunk += "\n```";
			rest = `\`\`\`\n${rest}`;
		}
		if (chunk !== "") chunks.push(chunk);
	}
	if (rest !== "") chunks.push(rest);
	return chunks;
}

/**
 * Breaks every `<tg-button>` and `<tg-button-row>` tag by putting a zero-width space after its `<`. A rich
 * message renders raw HTML, so model output could otherwise forge buttons that send callback data such as
 * approvals or session switches. Code is not exempt: telling code from HTML the way Telegram's parser does is
 * fragile (indented fences, escaped backticks), and the invisible character leaves code looking the same.
 */
export function neutralizeTelegramButtons(markdown: string): string {
	return markdown.replace(/<(?=\/?tg-button)/gi, "<\u200B");
}

/**
 * A user-visible list in the active locale, e.g. `en`: "a, b, c", `zh-CN`: "a、b、c".
 *
 * The list punctuation belongs to the locale, not to the code that builds the line: a hard-coded
 * `join(", ")` leaves an English comma in Chinese text. Every user-visible list (the WebUI and the chat
 * catalogues alike) goes through this helper.
 */
export function formatList(locale: string, items: readonly string[]): string {
	return new Intl.ListFormat(locale, { type: "conjunction", style: "narrow" }).format(items);
}

/**
 * Text that cannot round-trip through the conversation store: U+0000 and lone UTF-16 surrogates.
 *
 * PostgreSQL text can hold neither, and the durable store's searchable-text column decodes a message's JSON
 * back to text, so one such character fails the whole commit; a failed commit fails the durable Session and
 * with it every conversation the agent runtime holds (doc/design/data-model.md "Conversation content search").
 * The model should not see them either, so text that enters a message or leaves a tool replaces them with
 * U+FFFD, which is what a decoder does with an unrepresentable byte.
 *
 * A surrogate pair is one valid character (an emoji, for example) and is left alone.
 */
export function replaceInvalidText(text: string): string {
	// The character is written out rather than escaped in a regular expression literal, which the lint rules
	// reject as a control character.
	return text
		.replaceAll(String.fromCharCode(0), "\uFFFD")
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

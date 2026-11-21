/**
 * Escapes the characters a regular expression gives a meaning: the set of Go's regexp.QuoteMeta, which
 * JavaScript and RE2 read the same way. Other characters, including non-ASCII, stay literal.
 */
export function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

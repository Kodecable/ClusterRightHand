/** The first `maxBytes` bytes of `text` without splitting a code point. */
export function cutUtf8(text: string, maxBytes: number): string {
	let kept = "";
	let bytes = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		kept += char;
		bytes += size;
	}
	return kept;
}

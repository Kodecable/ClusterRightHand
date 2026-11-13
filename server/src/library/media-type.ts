/**
 * Content sniffing for library files (doc/design/library.md "Metadata and objects"): magic bytes for
 * the common binary formats, otherwise text when the content is valid UTF-8 without NUL, otherwise
 * application/octet-stream. SVG and HTML are text, so they are never served inline.
 */

/** The sniffed types served inline for a preview, and the largest preview. */
export const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const INLINE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** How much of the beginning is kept for magic-byte sniffing. */
const HEAD_BYTES = 16;

/** The magic-byte type of `head`, or undefined when no known format matches. */
export function sniffMagic(head: Uint8Array): string | undefined {
	const bytes = Buffer.from(head);
	const startsWith = (signature: string, offset = 0): boolean =>
		bytes.length >= offset + signature.length &&
		bytes.subarray(offset, offset + signature.length).toString("latin1") === signature;
	if (startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
	if (startsWith("\xff\xd8\xff")) return "image/jpeg";
	if (startsWith("GIF87a") || startsWith("GIF89a")) return "image/gif";
	if (startsWith("RIFF") && startsWith("WEBP", 8)) return "image/webp";
	if (startsWith("%PDF-")) return "application/pdf";
	if (startsWith("PK\x03\x04") || startsWith("PK\x05\x06") || startsWith("PK\x07\x08")) return "application/zip";
	if (startsWith("\x1f\x8b")) return "application/gzip";
	if (startsWith("7z\xbc\xaf\x27\x1c")) return "application/x-7z-compressed";
	if (startsWith("BZh")) return "application/x-bzip2";
	if (startsWith("OggS")) return "application/ogg";
	if (startsWith("fLaC")) return "audio/flac";
	if (startsWith("ID3")) return "audio/mpeg";
	if (startsWith("\x00asm")) return "application/wasm";
	return undefined;
}

/**
 * Watches a stream while it is written: keeps the first bytes for magic-byte sniffing, decodes the
 * content as UTF-8 as it passes and notes NUL bytes. `finish()` returns the sniffed media type.
 */
export class MediaProbe {
	#head = Buffer.alloc(0);
	#decoder = new TextDecoder("utf-8", { fatal: true });
	#text = true;
	#nul = false;

	push(chunk: Uint8Array): void {
		if (this.#head.length < HEAD_BYTES) {
			this.#head = Buffer.concat([this.#head, Buffer.from(chunk).subarray(0, HEAD_BYTES - this.#head.length)]);
		}
		if (this.#text) {
			if (chunk.includes(0)) this.#nul = true;
			try {
				this.#decoder.decode(chunk, { stream: true });
			} catch {
				this.#text = false;
			}
		}
	}

	/** The media type of the finished content. */
	finish(): string {
		if (this.#text) {
			try {
				this.#decoder.decode();
			} catch {
				this.#text = false;
			}
		}
		const magic = sniffMagic(this.#head);
		if (magic !== undefined) return magic;
		return this.#text && !this.#nul ? "text/plain" : "application/octet-stream";
	}
}

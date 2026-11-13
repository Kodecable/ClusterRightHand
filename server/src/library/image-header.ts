/**
 * The media type and pixel size of an image, read from its header without decoding the image
 * (doc/design/library.md "view_image"). Only the four formats the tool accepts are recognized.
 */
export interface ImageHeader {
	mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	width: number;
	height: number;
}

/** Reads the header of `bytes`; undefined when it is not a PNG, JPEG, GIF or WebP. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | undefined {
	const buffer = Buffer.from(bytes);
	if (buffer.length >= 24 && buffer.subarray(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n") {
		return { mime: "image/png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	if (
		buffer.length >= 10 &&
		(buffer.subarray(0, 6).toString("latin1") === "GIF87a" || buffer.subarray(0, 6).toString("latin1") === "GIF89a")
	) {
		return { mime: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
	}
	if (
		buffer.length >= 30 &&
		buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
		buffer.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return webpHeader(buffer);
	}
	if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return jpegHeader(buffer);
	return undefined;
}

function jpegHeader(buffer: Buffer): ImageHeader | undefined {
	let offset = 2;
	while (offset + 9 < buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = buffer[offset + 1] as number;
		// Standalone markers carry no length.
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			offset += 2;
			continue;
		}
		const length = buffer.readUInt16BE(offset + 2);
		const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isStartOfFrame) {
			if (offset + 9 > buffer.length) return undefined;
			return {
				mime: "image/jpeg",
				height: buffer.readUInt16BE(offset + 5),
				width: buffer.readUInt16BE(offset + 7),
			};
		}
		offset += 2 + length;
	}
	return undefined;
}

function webpHeader(buffer: Buffer): ImageHeader | undefined {
	const chunk = buffer.subarray(12, 16).toString("latin1");
	if (chunk === "VP8X" && buffer.length >= 30) {
		return {
			mime: "image/webp",
			width: 1 + buffer.readUIntLE(24, 3),
			height: 1 + buffer.readUIntLE(27, 3),
		};
	}
	if (chunk === "VP8 " && buffer.length >= 30) {
		return {
			mime: "image/webp",
			width: buffer.readUInt16LE(26) & 0x3fff,
			height: buffer.readUInt16LE(28) & 0x3fff,
		};
	}
	if (chunk === "VP8L" && buffer.length >= 25) {
		const bits = buffer.readUInt32LE(21);
		return {
			mime: "image/webp",
			width: (bits & 0x3fff) + 1,
			height: ((bits >> 14) & 0x3fff) + 1,
		};
	}
	return undefined;
}

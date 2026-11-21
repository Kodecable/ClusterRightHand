/**
 * A small reader for the release archives `scripts/package.ts` writes (GNU tar, gzip): it finds one
 * regular file by its path and returns its bytes. It reads ustar headers, GNU long names (`L`) and pax
 * path records (`x`); every other entry is skipped. Nothing is written to disk.
 */
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

export class TarError extends Error {
	override name = "TarError";
}

function field(header: Uint8Array, offset: number, length: number): string {
	const raw = header.subarray(offset, offset + length);
	const end = raw.indexOf(0);
	return Buffer.from(end === -1 ? raw : raw.subarray(0, end)).toString("utf8");
}

/** An octal size field; GNU's base-256 form (high bit set) is accepted for completeness. */
function size(header: Uint8Array): number {
	const raw = header.subarray(124, 136);
	if (((raw[0] ?? 0) & 0x80) !== 0) {
		let value = 0;
		for (let i = 1; i < raw.length; i++) value = value * 256 + (raw[i] ?? 0);
		if (!Number.isSafeInteger(value)) throw new TarError("entry size is out of range");
		return value;
	}
	const text = field(header, 124, 12).trim();
	if (!/^[0-7]*$/.test(text)) throw new TarError(`bad size field ${JSON.stringify(text)}`);
	return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksumOk(header: Uint8Array): boolean {
	const text = field(header, 148, 8).trim();
	if (!/^[0-7]+$/.test(text)) return false;
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
	return sum === Number.parseInt(text, 8);
}

/** The `path` record of a pax extended header, if any. */
function paxPath(data: Uint8Array): string | undefined {
	const text = Buffer.from(data).toString("utf8");
	let at = 0;
	let path: string | undefined;
	while (at < text.length) {
		const space = text.indexOf(" ", at);
		if (space === -1) break;
		const length = Number.parseInt(text.slice(at, space), 10);
		if (!Number.isSafeInteger(length) || length <= 0) throw new TarError("bad pax record");
		const record = text.slice(space + 1, at + length - 1);
		const equals = record.indexOf("=");
		if (equals !== -1 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
		at += length;
	}
	return path;
}

/** An entry name without a leading "./" or a trailing "/", as `tar -C dir .` and directories write them. */
function normalize(name: string): string {
	return name.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * The bytes of the regular file `wanted` in a gzipped tar archive. Fails when the archive is malformed,
 * when the file is missing or not a regular file, or when it or the uncompressed archive exceeds the
 * limits.
 */
export function extractTarFile(
	archive: Uint8Array,
	wanted: string,
	limits: { archiveBytes: number; fileBytes: number },
): Buffer {
	let tar: Buffer;
	try {
		tar = gunzipSync(archive, { maxOutputLength: limits.archiveBytes });
	} catch (err) {
		throw new TarError(`not a gzip archive within ${limits.archiveBytes} bytes: ${(err as Error).message}`);
	}
	let at = 0;
	let longName: string | undefined;
	while (at + BLOCK <= tar.length) {
		const header = tar.subarray(at, at + BLOCK);
		if (header.every((byte) => byte === 0)) break; // the end-of-archive blocks
		if (!checksumOk(header)) throw new TarError(`bad header checksum at offset ${at}`);
		const length = size(header);
		const type = String.fromCharCode(header[156] ?? 0);
		const dataStart = at + BLOCK;
		const dataEnd = dataStart + length;
		if (dataEnd > tar.length) throw new TarError("entry runs past the end of the archive");
		const data = tar.subarray(dataStart, dataEnd);
		at = dataStart + Math.ceil(length / BLOCK) * BLOCK;

		if (type === "L") {
			longName = field(data, 0, data.length);
			continue;
		}
		if (type === "x") {
			longName = paxPath(data) ?? longName;
			continue;
		}
		const prefix = field(header, 345, 155);
		const short = field(header, 0, 100);
		const name = normalize(longName ?? (prefix === "" ? short : `${prefix}/${short}`));
		longName = undefined;
		if (name !== normalize(wanted)) continue;
		if (type !== "0" && type !== "\0") throw new TarError(`${wanted} is not a regular file in the archive`);
		if (length > limits.fileBytes) throw new TarError(`${wanted} is larger than ${limits.fileBytes} bytes`);
		return Buffer.from(data);
	}
	throw new TarError(`the archive has no ${wanted}`);
}

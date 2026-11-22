/**
 * One page of whole lines from a byte stream, as `file.read` defines it (doc/design/execution.md "Task
 * types"): `lineCount` lines from `startLine`, whole lines only, at most `maxBytes`. The reader may start at
 * an anchor (a known line start) instead of the first byte, and reports the anchors the page found, so a
 * later page can start there (doc/design/agent-runtime.md "Read anchors").
 */

import { FILE_READ_MAX_BYTES } from "@crh/protocol";

/** Where a line starts: line `line` (1-based) begins at byte `byte`. */
export interface LineAnchor {
	line: number;
	byte: number;
}

/** What a page holds, in `file.read`'s result terms. */
export interface LinePageResult {
	from: number;
	to: number;
	eof: boolean;
	total: number | null;
	tooLong: boolean;
}

export interface LinePage {
	result: LinePageResult;
	/** The page's first line, and the line after it when the file goes on. */
	anchors: LineAnchor[];
}

export interface LinePageOptions {
	startLine: number;
	lineCount: number;
	/** The page cap; defaults to `file.read`'s 50 KiB. */
	maxBytes?: number;
	/** The file's size, to tell whether a page that ends on its line count also ends the file. */
	size: number;
	/** Start reading here instead of at the first byte; its line must not be past `startLine`. */
	from?: LineAnchor;
	signal?: AbortSignal;
}

/**
 * Reads one page. `open(start)` streams the file from byte `start`; `out` receives the page's bytes exactly
 * as the file has them. Skipped lines are never kept, so a long line before the page costs nothing.
 */
export async function readLinePage(
	open: (start: number) => AsyncIterable<Uint8Array>,
	out: (data: Uint8Array) => void,
	options: LinePageOptions,
): Promise<LinePage> {
	const { startLine, lineCount, size } = options;
	const maxBytes = options.maxBytes ?? FILE_READ_MAX_BYTES;
	const from = options.from !== undefined && options.from.line <= startLine ? options.from : { line: 1, byte: 0 };
	const result: LinePageResult = { from: 0, to: 0, eof: false, total: null, tooLong: false };
	const anchors: LineAnchor[] = [];
	let line = from.line;
	let lineStart = from.byte;
	// The byte offset of the chunk being scanned.
	let pos = from.byte;
	let part: Buffer[] = [];
	let partLength = 0;
	let written = 0;
	let pageLines = 0;
	let done = false;
	for await (const raw of open(from.byte)) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		const data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
		let start = 0;
		while (start < data.length) {
			const nl = data.indexOf(0x0a, start);
			const end = nl < 0 ? data.length : nl + 1;
			if (line >= startLine) {
				// The page keeps whole lines only: a line that would pass the cap ends it.
				if (written + partLength + (end - start) > maxBytes) {
					if (pageLines === 0) result.tooLong = true;
					done = true;
					break;
				}
				part.push(data.subarray(start, end));
				partLength += end - start;
			}
			start = end;
			if (nl < 0) break; // the line goes on in the next chunk
			const lineEnd = pos + end;
			if (line >= startLine) {
				out(Buffer.concat(part, partLength));
				written += partLength;
				if (pageLines === 0) {
					result.from = line;
					anchors.push({ line, byte: lineStart });
				}
				result.to = line;
				pageLines++;
				part = [];
				partLength = 0;
			}
			line++;
			lineStart = lineEnd;
			if (pageLines >= lineCount) {
				if (lineEnd >= size) {
					result.eof = true;
					result.total = result.to;
				} else {
					anchors.push({ line, byte: lineEnd });
				}
				done = true;
				break;
			}
		}
		if (done) break;
		pos += data.length;
	}
	if (!done) {
		// The stream ended: at a line boundary, or inside a last line without a newline.
		result.eof = true;
		const lastLineExists = pos > lineStart;
		if (partLength > 0) {
			out(Buffer.concat(part, partLength));
			if (pageLines === 0) {
				result.from = line;
				anchors.push({ line, byte: lineStart });
			}
			result.to = line;
		}
		result.total = lastLineExists ? line : line - 1;
	}
	return { result, anchors };
}

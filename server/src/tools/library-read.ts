/**
 * `read_file` on a library file (doc/design/library.md "Agent tools"): the same page of whole lines a node
 * read returns, by path, with no task. A library object never changes, so its SHA-256 is its version and
 * a deeper page starts at an earlier page's anchor (doc/design/agent-runtime.md "Read anchors").
 */

import { FILE_READ_MAX_BYTES } from "@crh/protocol";
import { libraryRef } from "../library/library.ts";
import { validateLibraryPath } from "../library/paths.ts";
import { UserError } from "../util/errors.ts";
import { readLinePage } from "../util/line-page.ts";
import type { ToolContext } from "./catalog.ts";
import { statToolLibrary, toolLibrary } from "./library-access.ts";
import { type ToolResult, textResult } from "./render.ts";

export interface LibraryReadArgs {
	library: string;
	path: string;
	startLine: number;
	lineCount: number;
	maxBytes?: number;
}

export async function readLibraryFile(ctx: ToolContext, args: LibraryReadArgs): Promise<ToolResult> {
	const path = validateLibraryPath(args.path);
	const record = await toolLibrary(ctx, args.library);
	const row = await statToolLibrary(ctx, args.library, path);
	const backend = ctx.cluster.libraryBackend;
	if (!backend) throw new UserError("this crhs has no library backend");
	const library = libraryRef(record.row, record.ownerName);
	const label = `${library}:${row.path}`;
	const details = { library, path: row.path, size: row.size, sha256: row.sha256 };
	const note = (fields: string[]): string => `[${[label, ...fields].join(", ")}]`;

	const anchors = ctx.cluster.readAnchors;
	const key = `library:${row.sha256}`;
	const from = anchors.best(key, row.sha256, args.startLine);
	const chunks: Buffer[] = [];
	const page = await readLinePage(
		(start) => backend.get(row.object_key, start),
		(data) => chunks.push(Buffer.from(data)),
		{
			startLine: args.startLine,
			lineCount: args.lineCount,
			maxBytes: Math.min(args.maxBytes ?? FILE_READ_MAX_BYTES, FILE_READ_MAX_BYTES),
			size: row.size,
			...(from ? { from } : {}),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		},
	);
	anchors.add(key, row.sha256, page.anchors);

	const { result } = page;
	const fail = (code: string, message: string): ToolResult =>
		textResult([{ note: note([`error ${code}: ${message}`]) }], { isError: true, details });
	if (result.tooLong) {
		return fail(
			"line_too_long",
			args.maxBytes === undefined
				? `line ${args.startLine} alone is longer than the 50 KB a page keeps; copy the file to a node and read it there with exec`
				: "no whole line fits in max_bytes; increase max_bytes or use a smaller offset",
		);
	}
	if (result.from === 0) {
		if (result.eof && result.total === 0) return textResult([{ note: note(["the file is empty"]) }], { details });
		return fail(
			"offset_out_of_range",
			`the file ${row.path} has ${result.total ?? 0} lines; line ${args.startLine} is past its end`,
		);
	}
	const output = Buffer.concat(chunks).toString("utf8");
	const fields = result.eof
		? [`lines ${result.from}-${result.to}${result.total === null ? "" : ` of ${result.total}`} (end of file)`]
		: [`lines ${result.from}-${result.to}. Use offset=${result.to + 1} to continue.`];
	return textResult([{ output, note: note(fields) }], { details });
}

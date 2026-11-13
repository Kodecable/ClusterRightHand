/**
 * Libraries on the tool surfaces (doc/design/library.md "Agent tools"): a `library` argument names
 * `user:<username>` or `group:<group name>`, and an agent session or API token reaches the libraries of
 * the user it acts for only, never through the administrator bypass.
 */

import { findLibraryFile, type LibraryFileRow, listLibraryFiles } from "../library/files.ts";
import { type LibraryRecord, libraryRef, requireOwnerLibrary } from "../library/library.ts";
import { UserError } from "../util/errors.ts";
import type { ToolContext } from "./catalog.ts";

export async function toolLibrary(ctx: ToolContext, ref: string): Promise<LibraryRecord> {
	return requireOwnerLibrary(ctx.db, ctx.user, ref);
}

export function libraryName(record: LibraryRecord): string {
	return libraryRef(record.row, record.ownerName);
}

export interface ToolLibraryListing {
	library: string;
	path: string;
	files: { path: string; name: string; size: number; media_type: string; updated_at: string }[];
	directories: string[];
}

/** A library directory as the model sees it: names, sizes and media types, never content. */
export async function listToolLibrary(ctx: ToolContext, ref: string, prefix: string): Promise<ToolLibraryListing> {
	const record = await toolLibrary(ctx, ref);
	const listing = await listLibraryFiles(ctx.db, record.row.id, prefix);
	return {
		library: libraryName(record),
		path: listing.prefix,
		files: listing.files.map((file) => ({
			path: file.path,
			name: file.path.slice(file.path.lastIndexOf("/") + 1),
			size: file.size,
			media_type: file.mediaType,
			updated_at: file.updatedAt,
		})),
		directories: listing.directories.map((name) => (listing.prefix === "" ? name : `${listing.prefix}/${name}`)),
	};
}

/** One library file's metadata. */
export async function statToolLibrary(ctx: ToolContext, ref: string, path: string): Promise<LibraryFileRow> {
	const record = await toolLibrary(ctx, ref);
	const row = await findLibraryFile(ctx.db, record.row.id, path);
	if (!row) throw new UserError(`no such library file ${path}`, "not_found");
	return row;
}

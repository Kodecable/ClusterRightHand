/**
 * `copy_file` with `recursive: true` (doc/design/library.md "Directory copies"): a directory goes into a
 * library only, from a node or another library, as a sequence of ordinary single-file copies. It is not
 * atomic: every file commits on its own, and a copy that fails halfway leaves the files it already copied
 * and says so. Everything that can be checked before the first change is checked first, so a refused copy
 * leaves the destination as it was.
 */

import { posix } from "node:path";
import { resolveTargets } from "../cluster/task-groups.ts";
import { copyLibraryFile, deleteLibraryFile, findLibraryFile, listLibraryDirectory } from "../library/files.ts";
import { libraryRef } from "../library/library.ts";
import { validateLibraryPath } from "../library/paths.ts";
import { DEFAULT_DIRECTORY_COPY_BYTES, DEFAULT_DIRECTORY_COPY_FILES } from "../settings/settings.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import type { ToolContext } from "./catalog.ts";
import { toolLibrary } from "./library-access.ts";
import { jsonResult, type ToolResult } from "./render.ts";
import { taskError } from "./task-render.ts";
import { waitBlockingTask } from "./task-tool.ts";

/** The advice every refusal gives: one archive is one file, which copies anywhere. */
const PACK_ADVICE = "pack the directory into one archive (tar on a node) and copy that file instead";

/** A `file.list` page large enough for any directory a copy may take. */
const LIST_LIMIT = 5000;

export type DirectorySource = { node: string; path: string } | { library: string; path: string };
export type DirectoryDestination =
	| { library: string; path: string }
	| { targets: string[]; path: string }
	| { user_interface: true };

/** One file to copy: where it is in the source, and its path below the destination. */
interface SourceFile {
	source: string;
	relativePath: string;
	size: number;
}

export async function copyDirectory(
	ctx: ToolContext,
	source: DirectorySource,
	destination: DirectoryDestination,
	overwrite: boolean,
): Promise<ToolResult> {
	if ("user_interface" in destination) {
		throw new UserError(`a directory cannot be offered to the user; ${PACK_ADVICE}`, "unsupported");
	}
	if ("targets" in destination) {
		throw new UserError(`a directory can be copied into a library only, not to nodes; ${PACK_ADVICE}`, "unsupported");
	}
	const backend = ctx.cluster.libraryBackend;
	if (!backend) throw new UserError("this crhs has no library backend");
	const target = await toolLibrary(ctx, destination.library);
	const library = libraryRef(target.row, target.ownerName);
	const root = validateLibraryPath(destination.path);
	const limits = ctx.directoryCopyLimits ?? {
		files: DEFAULT_DIRECTORY_COPY_FILES,
		bytes: DEFAULT_DIRECTORY_COPY_BYTES,
	};
	const tooLarge = (files: number, bytes: number): UserError =>
		new UserError(
			`the directory has at least ${files} files and ${bytes} bytes; one copy takes at most ${limits.files} files ` +
				`and ${limits.bytes} bytes; ${PACK_ADVICE}`,
			"too_large",
		);

	// ---- what to copy ----
	let files: SourceFile[];
	let skipped: string[] = [];
	let nodeId: string | undefined;
	let sourceLibraryId: string | undefined;
	let from: { library: string; path: string } | { node: string; path: string };
	if ("library" in source) {
		const record = await toolLibrary(ctx, source.library);
		const sourcePath = validateLibraryPath(source.path);
		sourceLibraryId = record.row.id;
		from = { library: libraryRef(record.row, record.ownerName), path: sourcePath };
		const rows = await listLibraryDirectory(ctx.db, record.row.id, sourcePath);
		if (rows.length === 0) {
			const file = await findLibraryFile(ctx.db, record.row.id, sourcePath);
			throw file
				? new UserError(`${sourcePath} is a file; copy it without recursive`, "invalid_argument")
				: new UserError(`no such library directory ${sourcePath}`, "not_found");
		}
		// The same library: the destination must not be the source, lie inside it, or hold it (an overwrite
		// would remove the source before it is copied).
		if (
			sourceLibraryId === target.row.id &&
			(root === sourcePath || root.startsWith(`${sourcePath}/`) || sourcePath.startsWith(`${root}/`))
		) {
			throw new UserError(
				"a directory cannot be copied onto itself, into itself or onto a directory that holds it",
				"invalid_argument",
			);
		}
		files = rows.map((row) => ({
			source: row.path,
			relativePath: row.path.slice(sourcePath.length + 1),
			size: row.size,
		}));
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		if (files.length > limits.files || bytes > limits.bytes) throw tooLarge(files.length, bytes);
	} else {
		const resolved = await resolveTargets(ctx.db, ctx.user, [source.node]);
		if (!resolved.singleNode) throw new UserError("source.node must name one node", "invalid_argument");
		nodeId = resolved.nodeIds[0] as string;
		const node = await ctx.db.selectFrom("nodes").select("name").where("id", "=", nodeId).executeTakeFirst();
		const nodeName = node?.name ?? nodeId;
		const sourcePath = posix.normalize(source.path).replace(/(.)\/$/, "$1");
		from = { node: nodeName, path: sourcePath };
		const walked = await walkNodeDirectory(ctx, nodeId, nodeName, sourcePath, limits, tooLarge);
		if ("result" in walked) return walked.result;
		files = walked.files;
		skipped = walked.skipped;
		// A node's file names need not be library paths (control characters, invalid UTF-8, length).
		for (const file of files) {
			try {
				validateLibraryPath(`${root}/${file.relativePath}`);
			} catch (err) {
				throw new UserError(
					`${file.source} cannot be a library file: ${err instanceof Error ? err.message : String(err)}; ${PACK_ADVICE}`,
					"invalid_argument",
				);
			}
		}
	}

	// ---- checks before the first change ----
	const parts = root.split("/");
	const blocking = await ctx.db
		.selectFrom("library_files")
		.select("path")
		.where("library_id", "=", target.row.id)
		.where(
			"path",
			"in",
			parts.map((_, index) => parts.slice(0, index + 1).join("/")),
		)
		.executeTakeFirst();
	if (blocking) throw new UserError(`a file already exists at ${blocking.path}`, "already_exists");
	const existing = await listLibraryDirectory(ctx.db, target.row.id, root);
	if (existing.length > 0 && !overwrite) {
		throw new UserError(`a directory already exists at ${root}; set overwrite to replace it`, "already_exists");
	}
	const row = target.row;
	const tooBig = files.find((file) => file.size > row.max_file_bytes);
	if (tooBig) {
		throw new UserError(
			`${tooBig.relativePath} (${tooBig.size} bytes) is larger than ${library}'s one-file limit of ${row.max_file_bytes} bytes`,
			"too_large",
		);
	}
	const fresh = await ctx.db.selectFrom("libraries").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
	const bytes = files.reduce((sum, file) => sum + file.size, 0);
	const filesAfter = fresh.used_files - existing.length + files.length;
	const bytesAfter = fresh.used_bytes - existing.reduce((sum, file) => sum + file.size, 0) + bytes;
	if (filesAfter > fresh.max_files || bytesAfter > fresh.max_total_bytes) {
		throw new UserError(
			`${library} would hold ${filesAfter} files and ${bytesAfter} bytes after the copy, past its limits of ` +
				`${fresh.max_files} files and ${fresh.max_total_bytes} bytes`,
			"too_large",
		);
	}

	// ---- the copy, one file at a time ----
	const removed: string[] = [];
	const copied: string[] = [];
	let failure: { code: string; message: string; path: string; removing?: boolean } | undefined;
	const failed = (err: unknown, path: string, removing?: boolean) => {
		// Any failure ends the copy where it is; the result says what was removed and copied, so it is never silent.
		const code =
			err instanceof UserError ? (err.code ?? "error") : err instanceof NotFoundError ? "not_found" : "error";
		failure = {
			code,
			message: err instanceof Error ? err.message : String(err),
			path,
			...(removing ? { removing } : {}),
		};
	};
	for (const file of existing) {
		try {
			await deleteLibraryFile(ctx.db, backend, row.id, file.path);
			removed.push(file.path);
		} catch (err) {
			failed(err, file.path, true);
			break;
		}
	}
	for (const file of failure === undefined ? files : []) {
		const path = `${root}/${file.relativePath}`;
		try {
			if (sourceLibraryId !== undefined) {
				await copyLibraryFile(
					ctx.db,
					backend,
					sourceLibraryId,
					file.source,
					{ libraryId: row.id, library: fresh },
					path,
					overwrite,
					ctx.user.userId,
				);
			} else {
				// A fresh task id: after a restart the copy runs again from the start, and a read has no side effect.
				const task = await ctx.cluster.pullLibraryFile({
					nodeId: nodeId as string,
					path: file.source,
					libraryId: row.id,
					libraryPath: path,
					overwrite,
					createdBy: ctx.user.userId,
					actor: ctx.actor,
					chain: ctx.chain,
					privileged: false,
					sourceToolTask: ctx.callKey ?? null,
				});
				const done = (await waitBlockingTask(ctx, task.id)) ?? task;
				if (done.state !== "exited" || done.errorCode !== null || done.result?.kind !== "file.pull") {
					const error = taskError(done) ?? {
						code: done.errorCode ?? done.state,
						message: done.errorMessage ?? done.state,
					};
					failure = { ...error, path: file.source };
					break;
				}
			}
			copied.push(path);
		} catch (err) {
			failed(err, file.source);
			break;
		}
	}

	void ctx.audit?.record({
		actor: { type: ctx.actor.type, id: ctx.actor.id, onBehalfOfUserId: ctx.actor.onBehalfOfUserId },
		action: "library.directory.copied",
		target: { type: "library", id: library },
		detail: {
			...("library" in from ? { from_library: from.library } : { from_node: from.node }),
			from_path: from.path,
			library,
			path: root,
			files: copied.length,
			of: files.length,
			replaced: existing.length,
			removed: removed.length,
			complete: failure === undefined,
		},
	});
	const summary = {
		library,
		path: root,
		files: copied.length,
		...(skipped.length > 0 ? { skipped } : {}),
	};
	if (failure !== undefined) {
		const what = failure.removing
			? `removing the old file ${failure.path} failed: ${failure.message}. ${removed.length} of ${existing.length} ` +
				"old files were removed and nothing was copied"
			: `copying ${failure.path} failed: ${failure.message}. The directory is incomplete: ${copied.length} of ` +
				`${files.length} files were copied${existing.length > 0 ? " and the old directory was removed" : ""}`;
		return jsonResult(
			{
				error: { code: failure.code, message: `${what}; copy it again with overwrite to replace it` },
				...summary,
				...(existing.length > 0 ? { removed } : {}),
				copied,
			},
			{ isError: true, details: { library, path: root } },
		);
	}
	return jsonResult({ ...summary, bytes }, { details: { library, path: root } });
}

/**
 * Lists the directory tree with `file.list` tasks under the ordinary rules, keeping regular files only.
 * Stops and refuses as soon as the tree passes a limit. A failed listing is returned as the tool result.
 */
async function walkNodeDirectory(
	ctx: ToolContext,
	nodeId: string,
	nodeName: string,
	root: string,
	limits: { files: number; bytes: number },
	tooLarge: (files: number, bytes: number) => UserError,
): Promise<{ files: SourceFile[]; skipped: string[] } | { result: ToolResult }> {
	const files: SourceFile[] = [];
	const skipped: string[] = [];
	let bytes = 0;
	const queue = [root];
	while (queue.length > 0) {
		const directory = queue.shift() as string;
		const task = await ctx.cluster.createTask({
			nodeId,
			spec: { kind: "file.list", path: directory, limit: LIST_LIMIT },
			actor: ctx.actor,
			chain: ctx.chain,
			privileged: false,
			sourceToolTask: ctx.callKey ?? null,
		});
		const done = (await waitBlockingTask(ctx, task.id)) ?? task;
		if (done.state !== "exited" || done.errorCode !== null || done.result?.kind !== "file.list") {
			const error = taskError(done) ?? { code: done.errorCode ?? done.state, message: done.errorMessage ?? done.state };
			return {
				result: jsonResult(
					{ error: { code: error.code, message: `listing ${nodeName}:${directory} failed: ${error.message}` } },
					{ isError: true },
				),
			};
		}
		if (done.result.truncated) {
			throw new UserError(`${directory} has more than ${LIST_LIMIT} entries; ${PACK_ADVICE}`, "too_large");
		}
		for (const entry of done.result.entries) {
			const path = posix.join(directory, entry.name);
			if (entry.type === "dir") {
				queue.push(path);
			} else if (entry.type === "file") {
				files.push({ source: path, relativePath: posix.relative(root, path), size: entry.size });
				bytes += entry.size;
				if (files.length > limits.files || bytes > limits.bytes) throw tooLarge(files.length, bytes);
			} else {
				skipped.push(path);
			}
		}
	}
	if (files.length === 0) throw new UserError(`${root} holds no regular files to copy`, "not_found");
	files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
	return { files, skipped };
}

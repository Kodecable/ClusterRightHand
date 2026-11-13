/**
 * Library files: listing, stat, upload and its atomic commit, delete and metadata-only moves
 * (doc/design/library.md "Metadata and objects" and "Limits"). Usage changes in the same transaction
 * as the file rows; the commit is one conditional update, so two racing uploads cannot both pass a
 * limit.
 */

import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import type { LibraryFile, LibraryLimitsPatch } from "@crh/api";
import { type Selectable, sql } from "kysely";
import type { Db } from "../storage/db.ts";
import type { LibrariesTable, LibraryFilesTable } from "../storage/schema.ts";
import { isUniqueViolation, NotFoundError, UserError } from "../util/errors.ts";
import { escapeLike } from "../util/list-query.ts";
import type { LibraryBackend } from "./backend.ts";
import { newObjectKey } from "./backend.ts";
import type { LibraryRecord } from "./library.ts";
import { findLibraryById } from "./library.ts";
import { MediaProbe } from "./media-type.ts";
import { numberedLibraryPath, validateLibraryPath, validateLibraryPrefix } from "./paths.ts";

export type LibraryFileRow = Selectable<LibraryFilesTable>;
export type LibraryRow = Selectable<LibrariesTable>;

/** The largest a library limit may be, matching the database's 32-bit integer column. */
const MAX_LIMIT = 2_147_483_647;
/** How many `name (n)` candidates an upload with `rename` tries before giving up. */
const MAX_RENAME_ATTEMPTS = 1000;

/** The candidate path of an upload that must not replace an existing file was taken; try the next one. */
class PathTaken extends Error {}

export function toLibraryFile(row: LibraryFileRow): LibraryFile {
	return {
		path: row.path,
		size: row.size,
		sha256: row.sha256,
		mediaType: row.media_type,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * The files directly under `prefix` and the names of the directories one level below it
 * (doc/design/library.md "Paths"). A directory exists only while a file is under it.
 */
export async function listLibraryFiles(
	db: Db,
	libraryId: string,
	prefix: string,
): Promise<{ prefix: string; files: LibraryFile[]; directories: string[] }> {
	const validPrefix = validateLibraryPrefix(prefix);
	let select = db.selectFrom("library_files").selectAll().where("library_id", "=", libraryId);
	if (validPrefix !== "") {
		const pattern = `${escapeLike(validPrefix)}/%`;
		select = select.where(sql<boolean>`path like ${pattern} escape '\\'`);
	}
	const rows = await select.orderBy("path").execute();
	const files: LibraryFile[] = [];
	const directories = new Set<string>();
	for (const row of rows) {
		const rest = validPrefix === "" ? row.path : row.path.slice(validPrefix.length + 1);
		const slash = rest.indexOf("/");
		if (slash === -1) files.push(toLibraryFile(row));
		else directories.add(rest.slice(0, slash));
	}
	return { prefix: validPrefix, files, directories: [...directories].sort() };
}

/** One file's metadata, or undefined. */
export async function findLibraryFile(db: Db, libraryId: string, path: string): Promise<LibraryFileRow | undefined> {
	const validPath = validateLibraryPath(path);
	return db
		.selectFrom("library_files")
		.selectAll()
		.where("library_id", "=", libraryId)
		.where("path", "=", validPath)
		.executeTakeFirst();
}

export interface LibraryUploadOptions {
	/** The library row, for its one-file limit; the commit re-checks the count and total limits. */
	library: LibraryRow;
	path: string;
	overwrite: boolean;
	/**
	 * Pick `name (n)` (the number before the first dot of the base name) when the path is taken, inside
	 * the commit, retrying on a concurrent insert (doc/design/library.md "Chat attachments").
	 */
	rename?: boolean;
	createdBy: string | null;
}

export interface LibraryUpload {
	/** Writes one chunk, refusing at the first byte past the one-file limit. */
	write(chunk: Uint8Array): Promise<void>;
	/** Ends the object; reports the bytes that were written and their SHA-256. */
	finish(): Promise<{ size: number; sha256: string }>;
	/** Commits the object into the library: one transaction for usage and the row. */
	commit(): Promise<{ file: LibraryFile; oldObjectKey?: string }>;
	/** Removes the new object; call it when the upload or its commit fails. */
	discard(): Promise<void>;
}

/** Starts writing a new object for `path`; nothing is visible in the library until `commit()`. */
export function beginLibraryUpload(db: Db, backend: LibraryBackend, options: LibraryUploadOptions): LibraryUpload {
	const { library, createdBy, rename } = options;
	// `rename` never replaces: an existing path just moves to the next numbered name.
	const overwrite = options.overwrite && !rename;
	const path = validateLibraryPath(options.path);
	const key = newObjectKey();
	const stream = new PassThrough();
	const probe = new MediaProbe();
	const put = backend.put(key, stream);
	// The backend may fail while nobody awaits put() yet; finish() still sees the rejection.
	void put.catch(() => {});
	let size = 0;
	let finished: Promise<{ size: number; sha256: string }> | undefined;
	let committed = false;
	let discarded = false;

	return {
		async write(chunk) {
			if (size + chunk.length > library.max_file_bytes) {
				throw new UserError("the file is larger than the library's one-file size limit");
			}
			size += chunk.length;
			probe.push(chunk);
			if (!stream.write(chunk)) await once(stream, "drain");
		},
		finish() {
			finished ??= (async () => {
				stream.end();
				return put;
			})();
			return finished;
		},
		async commit() {
			const actual = await this.finish();
			if (actual.size !== size) {
				throw new UserError(`the upload wrote ${size} bytes but the backend stored ${actual.size}`);
			}
			const mediaType = probe.finish();
			for (let attempt = 0; attempt < (rename ? MAX_RENAME_ATTEMPTS : 1); attempt++) {
				const target = attempt === 0 ? path : numberedLibraryPath(path, attempt);
				try {
					const result = await db.transaction().execute(async (trx) => {
						const existing = await trx
							.selectFrom("library_files")
							.select(["size", "backend", "object_key"])
							.where("library_id", "=", library.id)
							.where("path", "=", target)
							.executeTakeFirst();
						if (existing && !overwrite) {
							// A rename moves on to the next candidate; without one the upload is refused.
							if (rename) throw new PathTaken();
							throw new UserError(`a file already exists at ${target}`);
						}
						const fileDelta = existing ? 0 : 1;
						const byteDelta = actual.size - (existing?.size ?? 0);
						const updated = await trx
							.updateTable("libraries")
							.set({
								used_files: sql<number>`used_files + ${fileDelta}`,
								used_bytes: sql<number>`used_bytes + ${byteDelta}`,
							})
							.where("id", "=", library.id)
							.where(sql<boolean>`used_files + ${fileDelta} <= max_files`)
							.where(sql<boolean>`used_bytes + ${byteDelta} <= max_total_bytes`)
							.executeTakeFirst();
						if (updated.numUpdatedRows === 0n) throw await limitError(trx, library.id, fileDelta, byteDelta);
						const now = new Date().toISOString();
						if (existing) {
							await trx
								.updateTable("library_files")
								.set({
									size: actual.size,
									sha256: actual.sha256,
									media_type: mediaType,
									backend: backend.kind,
									object_key: key,
									updated_at: now,
								})
								.where("library_id", "=", library.id)
								.where("path", "=", target)
								.execute();
						} else {
							await trx
								.insertInto("library_files")
								.values({
									library_id: library.id,
									path: target,
									size: actual.size,
									sha256: actual.sha256,
									media_type: mediaType,
									backend: backend.kind,
									object_key: key,
									created_by: createdBy,
									created_at: now,
									updated_at: now,
								})
								.execute();
						}
						const row = await trx
							.selectFrom("library_files")
							.selectAll()
							.where("library_id", "=", library.id)
							.where("path", "=", target)
							.executeTakeFirstOrThrow();
						return {
							file: toLibraryFile(row),
							oldObjectKey: existing?.backend === backend.kind ? existing.object_key : undefined,
						};
					});
					committed = true;
					if (result.oldObjectKey !== undefined && result.oldObjectKey !== key) {
						await backend.delete(result.oldObjectKey).catch((err: unknown) => {
							console.error("library: deleting the replaced object failed:", err);
						});
					}
					return result;
				} catch (err) {
					// A concurrent upload took this name between the read and the insert: take the next one.
					if (err instanceof PathTaken || (rename && isUniqueViolation(err))) continue;
					throw err;
				}
			}
			throw new UserError(`too many files named like ${path}`);
		},
		async discard() {
			if (committed || discarded) return;
			discarded = true;
			stream.destroy();
			await put.catch(() => {});
			await backend.delete(key).catch((err: unknown) => {
				console.error("library: deleting an abandoned object failed:", err);
			});
		},
	};
}

/** The refusal after a failed conditional update: which of the library's limits the write would pass. */
async function limitError(trx: Db, libraryId: string, fileDelta: number, byteDelta: number): Promise<UserError> {
	const row = await trx
		.selectFrom("libraries")
		.select(["max_files", "max_total_bytes", "used_files", "used_bytes"])
		.where("id", "=", libraryId)
		.executeTakeFirstOrThrow();
	const filesAfter = row.used_files + fileDelta;
	const bytesAfter = row.used_bytes + byteDelta;
	if (filesAfter > row.max_files) return new UserError("the library's file count limit would be exceeded");
	return new UserError(
		`the library's total size limit would be exceeded (${bytesAfter} bytes after the write, limit ${row.max_total_bytes})`,
	);
}

/** Deletes a file's row and usage, then its object; deletes are always allowed (doc/design/library.md "Limits"). */
export async function deleteLibraryFile(
	db: Db,
	backend: LibraryBackend,
	libraryId: string,
	path: string,
): Promise<LibraryFile> {
	const row = await db.transaction().execute(async (trx) => {
		const existing = await trx
			.selectFrom("library_files")
			.selectAll()
			.where("library_id", "=", libraryId)
			.where("path", "=", path)
			.executeTakeFirst();
		if (!existing) throw new NotFoundError("no such library file");
		await trx.deleteFrom("library_files").where("library_id", "=", libraryId).where("path", "=", path).execute();
		await trx
			.updateTable("libraries")
			.set({
				used_files: sql<number>`used_files - 1`,
				used_bytes: sql<number>`used_bytes - ${existing.size}`,
			})
			.where("id", "=", libraryId)
			.execute();
		return existing;
	});
	if (row.backend === backend.kind) {
		await backend.delete(row.object_key).catch((err: unknown) => {
			console.error("library: deleting an object failed:", err);
		});
	}
	return toLibraryFile(row);
}

/** Moves or renames a file; only metadata changes. An existing target is refused unless `overwrite`. */
export async function moveLibraryFile(
	db: Db,
	libraryId: string,
	from: string,
	to: string,
	overwrite: boolean,
): Promise<LibraryFile> {
	const sourcePath = validateLibraryPath(from);
	const targetPath = validateLibraryPath(to);
	return db.transaction().execute(async (trx) => {
		const source = await trx
			.selectFrom("library_files")
			.selectAll()
			.where("library_id", "=", libraryId)
			.where("path", "=", sourcePath)
			.executeTakeFirst();
		if (!source) throw new NotFoundError("no such library file");
		const target = await trx
			.selectFrom("library_files")
			.selectAll()
			.where("library_id", "=", libraryId)
			.where("path", "=", targetPath)
			.executeTakeFirst();
		if (targetPath === sourcePath) return toLibraryFile(source);
		if (target && !overwrite) throw new UserError(`a file already exists at ${targetPath}`);
		if (target) {
			await trx
				.deleteFrom("library_files")
				.where("library_id", "=", libraryId)
				.where("path", "=", targetPath)
				.execute();
			await trx
				.updateTable("libraries")
				.set({
					used_files: sql<number>`used_files - 1`,
					used_bytes: sql<number>`used_bytes - ${target.size}`,
				})
				.where("id", "=", libraryId)
				.execute();
		}
		const now = new Date().toISOString();
		await trx
			.updateTable("library_files")
			.set({ path: targetPath, updated_at: now })
			.where("library_id", "=", libraryId)
			.where("path", "=", sourcePath)
			.execute();
		const row = await trx
			.selectFrom("library_files")
			.selectAll()
			.where("library_id", "=", libraryId)
			.where("path", "=", targetPath)
			.executeTakeFirstOrThrow();
		return toLibraryFile(row);
	});
}

/** Applies an administrators' limits change; omitted fields keep their value. */
export async function updateLibraryLimits(db: Db, libraryId: string, patch: LibraryLimitsPatch): Promise<LibraryRow> {
	const set: Partial<Pick<LibraryRow, "max_files" | "max_file_bytes" | "max_total_bytes">> = {};
	if (patch.files !== undefined) set.max_files = parseLimit(patch.files, "files");
	if (patch.fileBytes !== undefined) set.max_file_bytes = parseLimit(patch.fileBytes, "fileBytes");
	if (patch.totalBytes !== undefined) set.max_total_bytes = parseLimit(patch.totalBytes, "totalBytes");
	if (Object.keys(set).length > 0) {
		const result = await db.updateTable("libraries").set(set).where("id", "=", libraryId).executeTakeFirst();
		if (result.numUpdatedRows === 0n) throw new NotFoundError("no such library");
	}
	const row = await db.selectFrom("libraries").selectAll().where("id", "=", libraryId).executeTakeFirst();
	if (!row) throw new NotFoundError("no such library");
	return row;
}

function parseLimit(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_LIMIT) {
		throw new UserError(`${name} must be an integer between 0 and ${MAX_LIMIT}`);
	}
	return value;
}

/** Opens a stored library file's bytes (a push source). */
export async function openLibraryRead(
	db: Db,
	backend: LibraryBackend,
	libraryId: string,
	path: string,
): Promise<Readable> {
	const row = await findLibraryFile(db, libraryId, path);
	if (!row) throw new NotFoundError("no such library file");
	return backend.get(row.object_key);
}

/** The record a transfer location names, for its commit. */
export async function libraryForTransfer(db: Db, libraryId: string): Promise<LibraryRecord> {
	const record = await findLibraryById(db, libraryId);
	if (!record) throw new NotFoundError("no such library");
	return record;
}

/**
 * Copies a library file inside the backend (doc/design/library.md "Copies"): one get and one put, no task.
 * The destination's one-file limit is checked while streaming and its count and total limits at commit;
 * the source may be in another library.
 */
export async function copyLibraryFile(
	db: Db,
	backend: LibraryBackend,
	sourceLibraryId: string,
	sourcePath: string,
	destination: { libraryId: string; library: LibraryRow },
	destinationPath: string,
	overwrite: boolean,
	createdBy: string | null,
): Promise<LibraryFile> {
	const source = await findLibraryFile(db, sourceLibraryId, sourcePath);
	if (!source) throw new NotFoundError("no such library file");
	const path = validateLibraryPath(destinationPath);
	if (sourceLibraryId === destination.libraryId && source.path === path) return toLibraryFile(source);
	const upload = beginLibraryUpload(db, backend, {
		library: destination.library,
		path,
		overwrite,
		createdBy,
	});
	try {
		for await (const chunk of backend.get(source.object_key)) await upload.write(chunk as Uint8Array);
		await upload.finish();
		const { file } = await upload.commit();
		return file;
	} catch (err) {
		await upload.discard();
		throw err;
	}
}

/**
 * Where a file plane transfer puts its bytes on the crhs side (doc/design/library.md "File plane").
 *
 * The location is stored as JSON on the task row, so a transfer waiting for approval survives a
 * restart. There are two kinds: a staging file under crhs's data directory, and a library object
 * committed into a library path with the library's limit rules. A kind provides the four streaming
 * operations the transport needs: open a read stream, open a write stream, commit (verify and
 * publish) and discard.
 */
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { Db } from "../storage/db.ts";
import { UserError } from "../util/errors.ts";
import type { LibraryBackend } from "./backend.ts";
import { beginLibraryUpload, findLibraryFile, type LibraryUpload, libraryForTransfer } from "./files.ts";
import { validateLibraryPath } from "./paths.ts";

/** A stored location descriptor. `size`/`sha256` are known for a push source and unknown for a pull destination until it is committed. */
export interface StagingLocationJson {
	kind: "staging";
	/** The file's name below the staging directory. Never a path. */
	path: string;
	size: number | null;
	sha256: string | null;
}

/** A library object: a push source (its metadata is already known) or a pull destination. */
export interface LibraryLocationJson {
	kind: "library";
	libraryId: string;
	path: string;
	overwrite: boolean;
	/** The user a pulled file is recorded as created by. */
	createdBy: string | null;
	/** Known for a push source; null for a pull destination until it is committed. */
	size: number | null;
	sha256: string | null;
}

export type TransferLocationJson = StagingLocationJson | LibraryLocationJson;

/** What a location needs to reach the staging directory or a library. */
export interface TransferContext {
	root: string;
	db: Db;
	backend?: LibraryBackend;
}

/** A write stream with the size and hash the transport must verify before commit. */
export interface TransferWrite {
	/** Applies backpressure: resolves once the chunk was handed to the file. */
	write(chunk: Uint8Array): Promise<void>;
	/** Closes the file and reports its size and SHA-256. */
	finish(): Promise<{ size: number; sha256: string }>;
	/** Verifies the finished content against `expected` and publishes it. */
	commit(expected: { size: number; sha256: string }): Promise<void>;
	/** Removes everything this write created. */
	discard(): Promise<void>;
}

export interface TransferLocation {
	readonly spec: TransferLocationJson;
	openRead(): Readable;
	openWrite(): TransferWrite;
	discard(): Promise<void>;
}

interface LocationKind {
	openRead(context: TransferContext, spec: StagingLocationJson | LibraryLocationJson): Readable;
	openWrite(context: TransferContext, spec: StagingLocationJson | LibraryLocationJson): TransferWrite;
	discard(context: TransferContext, spec: StagingLocationJson | LibraryLocationJson): Promise<void>;
	/** Extra cleanup at startup; a kind may remove its leftovers here. */
	cleanup?(root: string): Promise<void>;
}

/** A staging file name is one path component, so a stored descriptor cannot escape the staging directory. */
function stagingPath(root: string, spec: StagingLocationJson): string {
	if (spec.path === "" || spec.path.includes("/") || spec.path === "." || spec.path === "..") {
		throw new UserError(`invalid staging location ${JSON.stringify(spec.path)}`);
	}
	return join(root, spec.path);
}

/** The library upload a write works on, resolved on first use so a stored descriptor needs no live context. */
function libraryUpload(context: TransferContext, spec: LibraryLocationJson): Promise<LibraryUpload> {
	if (!context.backend) throw new UserError("this crhs has no library backend");
	const backend = context.backend;
	return (async () => {
		const record = await libraryForTransfer(context.db, spec.libraryId);
		return beginLibraryUpload(context.db, backend, {
			library: record.row,
			path: spec.path,
			overwrite: spec.overwrite,
			createdBy: spec.createdBy,
		});
	})();
}

function libraryWrite(context: TransferContext, spec: LibraryLocationJson): TransferWrite {
	let pending: Promise<LibraryUpload> | undefined;
	const upload = (): Promise<LibraryUpload> => {
		pending ??= libraryUpload(context, spec);
		return pending;
	};
	return {
		async write(chunk) {
			await (await upload()).write(chunk);
		},
		async finish() {
			return (await upload()).finish();
		},
		async commit(expected) {
			const target = await upload();
			const actual = await target.finish();
			if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
				throw new UserError(
					`the received file does not match its declared size/sha256 (got ${actual.size} bytes, ${actual.sha256})`,
				);
			}
			await target.commit();
		},
		async discard() {
			if (!pending) return;
			const target = await pending.catch(() => undefined);
			await target?.discard();
		},
	};
}

function libraryReadable(context: TransferContext, spec: LibraryLocationJson): Readable {
	return Readable.from(
		(async function* () {
			const backend = context.backend;
			if (!backend) throw new UserError("this crhs has no library backend");
			const row = await findLibraryFile(context.db, spec.libraryId, spec.path);
			if (!row) throw new UserError(`no such library file ${spec.path}`);
			yield* backend.get(row.object_key);
		})(),
	);
}

async function writeTo(file: string, chunks: Readable): Promise<{ size: number; sha256: string }> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const out = createWriteStream(file, { mode: 0o600 });
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of chunks) {
		const data = chunk as Buffer;
		size += data.length;
		hash.update(data);
		if (!out.write(data)) await once(out, "drain");
	}
	out.end();
	await once(out, "finish");
	return { size, sha256: hash.digest("hex") };
}

function stagingWrite(root: string, spec: StagingLocationJson): TransferWrite {
	const target = stagingPath(root, spec);
	const temp = `${target}.crh-part-${randomBytes(6).toString("hex")}`;
	const hash = createHash("sha256");
	let size = 0;
	let stream: ReturnType<typeof createWriteStream> | undefined;
	let finished: { size: number; sha256: string } | undefined;
	let discarded = false;

	const openStream = async (): Promise<ReturnType<typeof createWriteStream>> => {
		if (stream) return stream;
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		stream = createWriteStream(temp, { mode: 0o600 });
		return stream;
	};

	return {
		async write(chunk) {
			const out = await openStream();
			size += chunk.length;
			hash.update(chunk);
			if (!out.write(chunk)) await once(out, "drain");
		},
		async finish() {
			if (finished) return finished;
			const out = await openStream();
			out.end();
			await once(out, "finish");
			finished = { size, sha256: hash.digest("hex") };
			return finished;
		},
		async commit(expected) {
			const actual = await this.finish();
			if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
				throw new UserError(
					`the received file does not match its declared size/sha256 (got ${actual.size} bytes, ${actual.sha256})`,
				);
			}
			await rename(temp, target);
			discarded = true;
		},
		async discard() {
			if (discarded) return;
			discarded = true;
			if (stream) stream.destroy();
			await rm(temp, { force: true });
		},
	};
}

const KINDS: Record<string, LocationKind> = {
	staging: {
		openRead(context, spec) {
			return createReadStream(stagingPath(context.root, spec as StagingLocationJson));
		},
		openWrite(context, spec) {
			return stagingWrite(context.root, spec as StagingLocationJson);
		},
		async discard(context, spec) {
			await rm(stagingPath(context.root, spec as StagingLocationJson), { force: true });
		},
		async cleanup(root) {
			await rm(root, { force: true, recursive: true });
		},
	},
	library: {
		openRead(context, spec) {
			return libraryReadable(context, spec as LibraryLocationJson);
		},
		openWrite(context, spec) {
			return libraryWrite(context, spec as LibraryLocationJson);
		},
		async discard(context, spec) {
			const target = await libraryUpload(context, spec as LibraryLocationJson).catch(() => undefined);
			await target?.discard();
		},
	},
};

function validSize(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function validSha256(value: unknown): value is string | null {
	return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

/** Validates a location descriptor read from a task row. */
export function locationFromJson(value: unknown): TransferLocationJson {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new UserError("transfer location is not an object");
	}
	const object = value as Record<string, unknown>;
	if (object.kind === "library") {
		if (typeof object.libraryId !== "string" || object.libraryId === "") {
			throw new UserError("library transfer location has no library id");
		}
		if (typeof object.path !== "string") throw new UserError("library transfer location has no path");
		validateLibraryPath(object.path);
		if (typeof object.overwrite !== "boolean") throw new UserError("library transfer location has no overwrite flag");
		if (object.createdBy !== null && typeof object.createdBy !== "string") {
			throw new UserError("library transfer location has an invalid createdBy");
		}
		if (!validSize(object.size) || !validSha256(object.sha256)) {
			throw new UserError("library transfer location size/sha256 is invalid");
		}
		return {
			kind: "library",
			libraryId: object.libraryId,
			path: object.path,
			overwrite: object.overwrite,
			createdBy: object.createdBy as string | null,
			size: object.size,
			sha256: object.sha256,
		};
	}
	if (object.kind !== "staging") throw new UserError(`unknown transfer location kind ${String(object.kind)}`);
	if (typeof object.path !== "string") throw new UserError("transfer location has no path");
	if (!validSize(object.size) || !validSha256(object.sha256)) {
		throw new UserError("transfer location size/sha256 is invalid");
	}
	return { kind: "staging", path: object.path, size: object.size, sha256: object.sha256 };
}

/** Opens a stored location descriptor against its context (the staging root and, for a library, the backend). */
export function openTransferLocation(context: TransferContext, value: unknown): TransferLocation {
	const spec = locationFromJson(value);
	const kind = KINDS[spec.kind];
	if (!kind) throw new UserError(`unknown transfer location kind ${spec.kind}`);
	return {
		spec,
		openRead: () => kind.openRead(context, spec),
		openWrite: () => kind.openWrite(context, spec),
		discard: () => kind.discard(context, spec),
	};
}

/** A new, empty staging pull destination. Its size and hash are recorded by the task result. */
export function newStagingLocation(): StagingLocationJson {
	return { kind: "staging", path: randomBytes(16).toString("hex"), size: null, sha256: null };
}

/** A new library pull destination; the limits and commit are checked when it is committed. */
export function newLibraryLocation(
	libraryId: string,
	path: string,
	options: { overwrite: boolean; createdBy: string | null; size?: number; sha256?: string },
): LibraryLocationJson {
	return {
		kind: "library",
		libraryId,
		path,
		overwrite: options.overwrite,
		createdBy: options.createdBy,
		size: options.size ?? null,
		sha256: options.sha256 ?? null,
	};
}

/** Stages a push source: writes the bytes under the staging root and returns the location. */
export async function stageFile(root: string, chunks: Readable): Promise<StagingLocationJson> {
	const spec = newStagingLocation();
	const target = stagingPath(root, spec);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const { size, sha256 } = await writeTo(target, chunks);
	return { ...spec, size, sha256 };
}

/** Stages a push source from a buffer, for tests and small callers. */
export async function stageBytes(root: string, data: Uint8Array): Promise<StagingLocationJson> {
	const spec = newStagingLocation();
	const target = stagingPath(root, spec);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const file = await open(target, "wx", 0o600);
	try {
		await file.writeFile(data);
	} finally {
		await file.close();
	}
	const sha256 = createHash("sha256").update(data).digest("hex");
	return { ...spec, size: data.length, sha256 };
}

/** Removes staging leftovers; crhs calls it at startup. */
export async function cleanupStaging(root: string): Promise<void> {
	await KINDS.staging?.cleanup?.(root);
}

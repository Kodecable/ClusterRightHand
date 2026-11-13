/**
 * Where a file plane transfer puts its bytes on the crhs side (doc/design/library.md "File plane").
 *
 * The location is stored as JSON on the task row, so a transfer waiting for approval survives a
 * restart. Phase 1 has one kind, a staging file under crhs's data directory; phase 2 adds library
 * objects by registering another kind here, without touching the transport. A kind provides the
 * four streaming operations the transport needs: open a read stream, open a write stream, commit
 * (verify and publish) and discard.
 */
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { UserError } from "../util/errors.ts";

/** A stored location descriptor. `size`/`sha256` are known for a push source and unknown for a pull destination until it is committed. */
export interface StagingLocationJson {
	kind: "staging";
	/** The file's name below the staging directory. Never a path. */
	path: string;
	size: number | null;
	sha256: string | null;
}

export type TransferLocationJson = StagingLocationJson;

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
	openRead(root: string, spec: StagingLocationJson): Readable;
	openWrite(root: string, spec: StagingLocationJson): TransferWrite;
	discard(root: string, spec: StagingLocationJson): Promise<void>;
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
		openRead(root, spec) {
			return createReadStream(stagingPath(root, spec));
		},
		openWrite: stagingWrite,
		async discard(root, spec) {
			await rm(stagingPath(root, spec), { force: true });
		},
		async cleanup(root) {
			await rm(root, { force: true, recursive: true });
		},
	},
};

/** Validates a location descriptor read from a task row. */
export function locationFromJson(value: unknown): TransferLocationJson {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new UserError("transfer location is not an object");
	}
	const object = value as Record<string, unknown>;
	if (object.kind !== "staging") throw new UserError(`unknown transfer location kind ${String(object.kind)}`);
	if (typeof object.path !== "string") throw new UserError("transfer location has no path");
	const size = object.size;
	const sha256 = object.sha256;
	if (size !== null && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)) {
		throw new UserError("transfer location size is invalid");
	}
	if (sha256 !== null && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))) {
		throw new UserError("transfer location sha256 is invalid");
	}
	return { kind: "staging", path: object.path, size: size as number | null, sha256: sha256 as string | null };
}

/** Opens a stored location descriptor against the staging root. */
export function openTransferLocation(root: string, value: unknown): TransferLocation {
	const spec = locationFromJson(value);
	const kind = KINDS[spec.kind];
	if (!kind) throw new UserError(`unknown transfer location kind ${spec.kind}`);
	return {
		spec,
		openRead: () => kind.openRead(root, spec),
		openWrite: () => kind.openWrite(root, spec),
		discard: () => kind.discard(root, spec),
	};
}

/** A new, empty pull destination. Its size and hash are recorded by the task result. */
export function newStagingLocation(): StagingLocationJson {
	return { kind: "staging", path: randomBytes(16).toString("hex"), size: null, sha256: null };
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

/**
 * The library object store (doc/design/library.md "Backends"): put, get, delete and list, all
 * streaming. One backend serves every library; `local` stores objects as files under crhs's data
 * directory, `webdav` in a collection. Object keys are random and never derived from a path.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LibraryConfig } from "../config.ts";
import { createWebdavBackend } from "./webdav.ts";

/** One object found by `list()`. */
export interface LibraryObject {
	key: string;
	/** Milliseconds since the epoch; undefined when the backend does not report it. */
	lastModified?: number;
}

export interface LibraryBackend {
	/** The value stored in `library_files.backend`. */
	readonly kind: string;
	/** Streams `source` to a new object and reports its size and SHA-256. */
	put(key: string, source: Readable): Promise<{ size: number; sha256: string }>;
	get(key: string): Readable;
	/** Deletes an object; a missing object is not an error. */
	delete(key: string): Promise<void>;
	/** Every object of the store, for the orphan sweep. */
	list(): AsyncIterable<LibraryObject>;
	/** The image cache's area, outside every library (doc/design/library.md "Image cache"). */
	putCache(key: string, source: Readable): Promise<{ size: number; sha256: string }>;
	getCache(key: string): Readable;
	deleteCache(key: string): Promise<void>;
	listCache(): AsyncIterable<LibraryObject>;
}

/** A random object key: never derived from a path, so a move or overwrite is pure metadata. */
export function newObjectKey(): string {
	return randomBytes(16).toString("hex");
}

/**
 * The one-level shard of an object key: its first two hex characters. A backend maps a key to
 * `<shard>/<key>`, spreading the store over at most 256 shards (doc/design/library.md "Backends").
 */
export function objectShard(key: string): string {
	return key.slice(0, 2);
}

/** An image cache key is the image's hex SHA-256, so one image has one object. */
export function checkCacheKey(key: string): string {
	if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`invalid image cache key ${JSON.stringify(key)}`);
	return key;
}

/** Rejects a key that is not one of ours before it becomes a file name. */
export function checkObjectKey(key: string): string {
	if (!/^[0-9a-f]{32}$/.test(key)) throw new Error(`invalid library object key ${JSON.stringify(key)}`);
	return key;
}

/** Creates the configured backend. `localRoot` is the `library/` directory under crhs's data directory. */
export function createLibraryBackend(config: LibraryConfig, localRoot: string): LibraryBackend {
	return config.backend === "local" ? new LocalLibraryBackend(localRoot) : createWebdavBackend(config);
}

class LocalLibraryBackend implements LibraryBackend {
	readonly kind = "local";
	readonly #root: string;

	constructor(root: string) {
		this.#root = root;
	}

	#path(key: string): string {
		const name = checkObjectKey(key);
		return join(this.#root, objectShard(name), name);
	}

	async put(key: string, source: Readable): Promise<{ size: number; sha256: string }> {
		return this.#writeObject(this.#path(key), source);
	}

	/**
	 * Streams `source` to `target` through a hashing counter. `pipeline` owns every stream's errors:
	 * a failing destination (ENOSPC, EACCES, EMFILE) rejects even while `source` is still being read,
	 * where a bare `for await` would leave it unhandled and crash crhs.
	 */
	async #writeObject(target: string, source: Readable): Promise<{ size: number; sha256: string }> {
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		const temp = `${target}.crh-part-${randomBytes(6).toString("hex")}`;
		const hash = createHash("sha256");
		let size = 0;
		const counter = new Transform({
			transform(chunk, _encoding, callback) {
				const bytes = Buffer.from(chunk);
				size += bytes.length;
				hash.update(bytes);
				callback(null, bytes);
			},
		});
		try {
			await pipeline(source, counter, createWriteStream(temp, { mode: 0o600 }));
			await rename(temp, target);
			return { size, sha256: hash.digest("hex") };
		} catch (err) {
			await rm(temp, { force: true });
			throw err;
		}
	}

	get(key: string): Readable {
		return createReadStream(this.#path(key));
	}

	async delete(key: string): Promise<void> {
		// A crashed upload leaves `<key>.crh-part-…` behind; the sweep must be able to remove it too.
		const name = /^[0-9a-f]{32}(?:\.crh-part-[0-9a-f]{12})?$/.test(key) ? key : checkObjectKey(key);
		await rm(join(this.#root, objectShard(name), name), { force: true });
	}

	async *list(): AsyncIterable<LibraryObject> {
		yield* listShardedObjects(this.#root, /^[0-9a-f]{32}(?:\.crh-part-[0-9a-f]{12})?$/);
	}

	async putCache(key: string, source: Readable): Promise<{ size: number; sha256: string }> {
		const name = checkCacheKey(key);
		return this.#writeObject(join(this.#root, "cache", objectShard(name), name), source);
	}

	getCache(key: string): Readable {
		const name = checkCacheKey(key);
		return createReadStream(join(this.#root, "cache", objectShard(name), name));
	}

	async deleteCache(key: string): Promise<void> {
		// Like delete: a crashed putCache leaves `<key>.crh-part-…` for the cache sweep.
		const name = /^[0-9a-f]{64}(?:\.crh-part-[0-9a-f]{12})?$/.test(key) ? key : checkCacheKey(key);
		await rm(join(this.#root, "cache", objectShard(name), name), { force: true });
	}

	async *listCache(): AsyncIterable<LibraryObject> {
		yield* listShardedObjects(join(this.#root, "cache"), /^[0-9a-f]{64}(?:\.crh-part-[0-9a-f]{12})?$/);
	}
}

/** Lists the objects under `root`'s two-hex-character shard directories; anything else is left alone. */
async function* listShardedObjects(root: string, namePattern: RegExp): AsyncIterable<LibraryObject> {
	let shards: Dirent[];
	try {
		shards = await readdir(root, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
	for (const shard of shards) {
		if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
		const directory = join(root, shard.name);
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !namePattern.test(entry.name)) continue;
			try {
				const info = await stat(join(directory, entry.name));
				yield { key: entry.name, lastModified: info.mtimeMs };
			} catch {
				// The object vanished between readdir and stat; there is nothing to sweep.
			}
		}
	}
}

/** Convenience for tests and small callers: writes a buffer as one object. */
export async function putBytes(
	backend: LibraryBackend,
	key: string,
	data: Uint8Array,
): Promise<{ size: number; sha256: string }> {
	return backend.put(key, Readable.from([Buffer.from(data)]));
}

/** Reads a whole object, for tests. */
export async function getBytes(backend: LibraryBackend, key: string): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of backend.get(key)) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

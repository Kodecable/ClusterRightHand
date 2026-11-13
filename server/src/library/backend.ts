/**
 * The library object store (doc/design/library.md "Backends"): put, get, delete and list, all
 * streaming. One backend serves every library; `local` stores objects as files under crhs's data
 * directory, `webdav` in a collection. Object keys are random and never derived from a path.
 */
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Dirent } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
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
}

/** A random object key: never derived from a path, so a move or overwrite is pure metadata. */
export function newObjectKey(): string {
	return randomBytes(16).toString("hex");
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
		return join(this.#root, checkObjectKey(key));
	}

	async put(key: string, source: Readable): Promise<{ size: number; sha256: string }> {
		const target = this.#path(key);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		const temp = `${target}.crh-part-${randomBytes(6).toString("hex")}`;
		const hash = createHash("sha256");
		let size = 0;
		const out = createWriteStream(temp, { mode: 0o600 });
		try {
			for await (const chunk of source) {
				const bytes = Buffer.from(chunk);
				size += bytes.length;
				hash.update(bytes);
				if (!out.write(bytes)) await once(out, "drain");
			}
			out.end();
			await once(out, "finish");
			await rename(temp, target);
			return { size, sha256: hash.digest("hex") };
		} catch (err) {
			out.destroy();
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
		await rm(join(this.#root, name), { force: true });
	}

	async *list(): AsyncIterable<LibraryObject> {
		let entries: Dirent[];
		try {
			entries = await readdir(this.#root, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			try {
				const info = await stat(join(this.#root, entry.name));
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

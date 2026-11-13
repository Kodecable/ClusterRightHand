/**
 * The image cache (doc/design/library.md "Image cache"): the bytes behind `view_image` results, in a
 * disposable directory on crhs's local disk. A row in `image_cache` indexes each object's size, media
 * type, last use and stored time. Entries are dropped by least recent use and by age; the cache is
 * bounded by its size setting. Repeated reads rely on the operating system's page cache.
 */
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Db } from "../storage/db.ts";

/** What the cache keeps of one image. */
export interface CachedImage {
	bytes: Buffer;
	mime: string;
}

/** The text a rejected image's tool result and request placeholder carry (doc/design/library.md "view_image"). */
export const REJECTED_IMAGE_TEXT = "This image was rejected by the model provider; it was not sent.";

/** The limits the cache reads at use time, so a settings change applies without a restart. */
export interface ImageCacheLimits {
	diskBytes: number;
	ttlMs: number;
}

/** A sweep never deletes a cache object younger than this, so one being written now is not lost. */
const MIN_OBJECT_AGE_MS = 60 * 60 * 1000;

/** Cache file names: the hex SHA-256, and a write's temporary `<sha256>.crh-part-…` sibling. */
const CACHE_NAME_RE = /^[0-9a-f]{64}(?:\.crh-part-[0-9a-f]{12})?$/;

export class ImageCache {
	readonly #db: Db;
	readonly #root: string;
	readonly #limits: () => ImageCacheLimits;

	constructor(db: Db, root: string, limits: () => ImageCacheLimits) {
		this.#db = db;
		this.#root = root;
		this.#limits = limits;
	}

	/** The file of one cache object; the name is hex SHA-256, split into a two-character shard. */
	#path(name: string): string {
		if (!CACHE_NAME_RE.test(name)) throw new Error(`invalid image cache key ${JSON.stringify(name)}`);
		return join(this.#root, name.slice(0, 2), name);
	}

	/**
	 * Stores one image; a repeated SHA-256 refreshes the entry instead of adding another, keeping its
	 * original `stored_at` because the bytes never left the cache. `storedAt` backdates a new entry when
	 * a library re-read restores a result (doc/design/library.md "Image cache"); a normal write defaults to now.
	 */
	async put(sha256: string, mime: string, bytes: Uint8Array, storedAt = Date.now()): Promise<void> {
		const data = Buffer.from(bytes);
		const target = this.#path(sha256);
		const temp = `${target}.crh-part-${randomBytes(6).toString("hex")}`;
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		try {
			await writeFile(temp, data, { mode: 0o600 });
			await rename(temp, target);
		} catch (err) {
			await rm(temp, { force: true });
			throw err;
		}
		const now = Date.now();
		await this.#db
			.insertInto("image_cache")
			.values({
				sha256,
				bytes: data.length,
				mime,
				last_used_at: new Date(now).toISOString(),
				stored_at: new Date(storedAt).toISOString(),
			})
			.onConflict((conflict) =>
				conflict.column("sha256").doUpdateSet({
					bytes: data.length,
					mime,
					last_used_at: new Date(now).toISOString(),
				}),
			)
			.execute();
	}

	/** When the entry was written, or undefined when it is gone. */
	async storedAt(sha256: string): Promise<number | undefined> {
		const row = await this.#db
			.selectFrom("image_cache")
			.select("stored_at")
			.where("sha256", "=", sha256)
			.executeTakeFirst();
		return row === undefined ? undefined : Date.parse(row.stored_at);
	}

	/** The image for a SHA-256, or undefined when it is no longer cached. */
	async get(sha256: string): Promise<CachedImage | undefined> {
		const row = await this.#db.selectFrom("image_cache").selectAll().where("sha256", "=", sha256).executeTakeFirst();
		if (!row) return undefined;
		let bytes: Buffer;
		try {
			bytes = await readFile(this.#path(sha256));
		} catch {
			// The row outlived its object (a failed write or a manual cleanup): forget it.
			await this.#db.deleteFrom("image_cache").where("sha256", "=", sha256).execute();
			return undefined;
		}
		await this.#db
			.updateTable("image_cache")
			.set({ last_used_at: new Date().toISOString() })
			.where("sha256", "=", sha256)
			.execute();
		return { bytes, mime: row.mime };
	}

	/**
	 * Evicts entries by size (least recently used first) and by age, and removes objects whose row is
	 * gone. Returns how many rows were dropped.
	 */
	async sweep(now = Date.now()): Promise<number> {
		const { diskBytes, ttlMs } = this.#limits();
		const rows = await this.#db.selectFrom("image_cache").selectAll().orderBy("last_used_at", "asc").execute();
		const known = new Set(rows.map((row) => row.sha256));
		let total = rows.reduce((sum, row) => sum + row.bytes, 0);
		let dropped = 0;
		for (const row of rows) {
			const expired = now - Date.parse(row.last_used_at) > ttlMs;
			if (!expired && total <= diskBytes) continue;
			await this.#db.deleteFrom("image_cache").where("sha256", "=", row.sha256).execute();
			await this.#delete(row.sha256);
			total -= row.bytes;
			dropped += 1;
		}
		for await (const object of this.#objects()) {
			if (known.has(object.name)) continue;
			// An object without a row is a put that failed between the two writes, or already swept metadata.
			if (now - object.modifiedAt < MIN_OBJECT_AGE_MS) continue;
			await this.#delete(object.name);
		}
		return dropped;
	}

	async #delete(name: string): Promise<void> {
		await rm(this.#path(name), { force: true }).catch((err: unknown) => {
			console.error(`image cache: deleting ${name} failed:`, err);
		});
	}

	/** Lists the shards' cache files; anything else under the root is left alone. */
	async *#objects(): AsyncIterable<{ name: string; modifiedAt: number }> {
		let shards: Dirent[];
		try {
			shards = await readdir(this.#root, { withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		for (const shard of shards) {
			if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
			const directory = join(this.#root, shard.name);
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (!entry.isFile() || !CACHE_NAME_RE.test(entry.name)) continue;
				try {
					const info = await stat(join(directory, entry.name));
					yield { name: entry.name, modifiedAt: info.mtimeMs };
				} catch {
					// The object vanished between readdir and stat; there is nothing to sweep.
				}
			}
		}
	}
}

/** A sweep's interval; the same as the library orphan sweep's. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface ImageCacheSweep {
	stop(): Promise<void>;
}

/** Runs the sweep once at startup and then hourly, never overlapping itself. */
export function startImageCacheSweep(cache: ImageCache, intervalMs = SWEEP_INTERVAL_MS): ImageCacheSweep {
	let running: Promise<void> | null = null;
	let stopped = false;
	const tick = (): void => {
		if (stopped || running !== null) return;
		running = cache
			.sweep()
			.then(() => {})
			.catch((err: unknown) => console.error("image cache sweep failed:", err))
			.finally(() => {
				running = null;
			});
	};
	void tick();
	const interval = setInterval(tick, intervalMs);
	interval.unref();
	return {
		async stop(): Promise<void> {
			stopped = true;
			clearInterval(interval);
			await running;
		},
	};
}

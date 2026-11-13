/**
 * The image cache (doc/design/library.md "Image cache"): the bytes behind `view_image` results, in an
 * in-process LRU in front of an object area of the library backend. A row in `image_cache` indexes each
 * object's size, media type, last use and stored time. Both tiers drop entries by least recent use and by
 * age; the disk tier is bounded by its size setting.
 */
import { Readable } from "node:stream";
import type { Db } from "../storage/db.ts";
import type { LibraryBackend } from "./backend.ts";

/** What the cache keeps of one image. */
export interface CachedImage {
	bytes: Buffer;
	mime: string;
}

/** The text a rejected image's tool result and request placeholder carry (doc/design/library.md "view_image"). */
export const REJECTED_IMAGE_TEXT = "This image was rejected by the model provider; it was not sent.";

/** The limits the cache reads at use time, so a settings change applies without a restart. */
export interface ImageCacheLimits {
	memoryBytes: number;
	diskBytes: number;
	ttlMs: number;
}

interface MemoryEntry extends CachedImage {
	lastUsed: number;
}

/** A sweep never deletes a cache object younger than this, so one being written now is not lost. */
const MIN_OBJECT_AGE_MS = 60 * 60 * 1000;

export class ImageCache {
	readonly #db: Db;
	readonly #backend: LibraryBackend;
	readonly #limits: () => ImageCacheLimits;
	/** Map order is LRU order: the first key is the least recently used. */
	readonly #memory = new Map<string, MemoryEntry>();
	#memoryBytes = 0;

	constructor(db: Db, backend: LibraryBackend, limits: () => ImageCacheLimits) {
		this.#db = db;
		this.#backend = backend;
		this.#limits = limits;
	}

	/** Bytes the memory tier holds now (diagnostics and tests). */
	get memoryBytes(): number {
		return this.#memoryBytes;
	}

	/**
	 * Stores one image in both tiers; a repeated SHA-256 refreshes the entry instead of adding another, keeping
	 * its original `stored_at` because the bytes never left the disk tier. `storedAt` backdates a new entry when
	 * a library re-read restores a result (doc/design/library.md "Image cache"); a normal write defaults to now.
	 */
	async put(sha256: string, mime: string, bytes: Uint8Array, storedAt = Date.now()): Promise<void> {
		const data = Buffer.from(bytes);
		const now = Date.now();
		await this.#backend.putCache(sha256, Readable.from([data]));
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
		this.#remember(sha256, { bytes: data, mime, lastUsed: now });
	}

	/** When the disk-tier entry was written, or undefined when it is gone; the memory tier does not count. */
	async storedAt(sha256: string): Promise<number | undefined> {
		const row = await this.#db
			.selectFrom("image_cache")
			.select("stored_at")
			.where("sha256", "=", sha256)
			.executeTakeFirst();
		return row === undefined ? undefined : Date.parse(row.stored_at);
	}

	/** The image for a SHA-256, or undefined when neither tier has it any more. */
	async get(sha256: string): Promise<CachedImage | undefined> {
		const now = Date.now();
		const cached = this.#memory.get(sha256);
		if (cached) {
			cached.lastUsed = now;
			this.#memory.delete(sha256);
			this.#memory.set(sha256, cached);
			return { bytes: cached.bytes, mime: cached.mime };
		}
		const row = await this.#db.selectFrom("image_cache").selectAll().where("sha256", "=", sha256).executeTakeFirst();
		if (!row) return undefined;
		let bytes: Buffer;
		try {
			bytes = await readAll(this.#backend.getCache(sha256));
		} catch {
			// The row outlived its object (a failed backend or a manual cleanup): forget it.
			await this.#db.deleteFrom("image_cache").where("sha256", "=", sha256).execute();
			return undefined;
		}
		await this.#db
			.updateTable("image_cache")
			.set({ last_used_at: new Date(now).toISOString() })
			.where("sha256", "=", sha256)
			.execute();
		this.#remember(sha256, { bytes, mime: row.mime, lastUsed: now });
		return { bytes, mime: row.mime };
	}

	/** Forgets a memory entry only; the disk object and row stay until the sweep. */
	forget(sha256: string): void {
		const cached = this.#memory.get(sha256);
		if (!cached) return;
		this.#memory.delete(sha256);
		this.#memoryBytes -= cached.bytes.length;
	}

	/** Drops least recently used entries past the memory size, and entries unused for longer than the TTL. */
	sweepMemory(now = Date.now()): number {
		const { memoryBytes, ttlMs } = this.#limits();
		let dropped = 0;
		for (const [sha256, entry] of this.#memory) {
			const expired = now - entry.lastUsed > ttlMs;
			if (!expired && this.#memoryBytes <= memoryBytes) break;
			this.#memory.delete(sha256);
			this.#memoryBytes -= entry.bytes.length;
			dropped += 1;
		}
		return dropped;
	}

	/**
	 * Evicts the disk tier by size (least recently used first) and by age, and removes objects whose row is
	 * gone. Returns how many rows were dropped.
	 */
	async sweep(now = Date.now()): Promise<number> {
		this.sweepMemory(now);
		const { diskBytes, ttlMs } = this.#limits();
		const rows = await this.#db.selectFrom("image_cache").selectAll().orderBy("last_used_at", "asc").execute();
		const known = new Set(rows.map((row) => row.sha256));
		let total = rows.reduce((sum, row) => sum + row.bytes, 0);
		let dropped = 0;
		for (const row of rows) {
			const expired = now - Date.parse(row.last_used_at) > ttlMs;
			if (!expired && total <= diskBytes) continue;
			await this.#db.deleteFrom("image_cache").where("sha256", "=", row.sha256).execute();
			await this.#backend.deleteCache(row.sha256).catch((err: unknown) => {
				console.error(`image cache: deleting ${row.sha256} failed:`, err);
			});
			this.forget(row.sha256);
			total -= row.bytes;
			dropped += 1;
		}
		for await (const object of this.#backend.listCache()) {
			if (known.has(object.key)) continue;
			// An object without a row is a put that failed between the two writes, or already swept metadata.
			if (object.lastModified !== undefined && now - object.lastModified < MIN_OBJECT_AGE_MS) continue;
			await this.#backend.deleteCache(object.key).catch((err: unknown) => {
				console.error(`image cache: deleting orphan ${object.key} failed:`, err);
			});
		}
		return dropped;
	}

	#remember(sha256: string, entry: MemoryEntry): void {
		const previous = this.#memory.get(sha256);
		if (previous) this.#memoryBytes -= previous.bytes.length;
		this.#memory.delete(sha256);
		this.#memory.set(sha256, entry);
		this.#memoryBytes += entry.bytes.length;
		this.sweepMemory(entry.lastUsed);
	}
}

async function readAll(chunks: Readable): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const chunk of chunks) parts.push(Buffer.from(chunk));
	return Buffer.concat(parts);
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

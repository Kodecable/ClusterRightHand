import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibraryBackend } from "../src/library/backend.ts";
import { ImageCache, type ImageCacheLimits } from "../src/library/image-cache.ts";
import { readImageHeader } from "../src/library/image-header.ts";
import { sweepLibraryOrphans } from "../src/library/sweep.ts";
import type { Db } from "../src/storage/db.ts";
import { openTestDb } from "./helpers/db.ts";

/** A PNG header long enough for the size fields; the image bytes themselves never need to decode. */
function png(width: number, height: number, fill = 1): Buffer {
	const header = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
	const size = Buffer.alloc(8);
	size.writeUInt32BE(width, 0);
	size.writeUInt32BE(height, 4);
	return Buffer.concat([header, size, Buffer.alloc(fill, 7)]);
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("image headers", () => {
	it("reads PNG, JPEG, GIF and WebP size from the header", () => {
		expect(readImageHeader(png(800, 600))).toEqual({ mime: "image/png", width: 800, height: 600 });
		const gif = Buffer.alloc(13);
		gif.write("GIF89a", 0, "latin1");
		gif.writeUInt16LE(320, 6);
		gif.writeUInt16LE(200, 8);
		expect(readImageHeader(gif)).toEqual({ mime: "image/gif", width: 320, height: 200 });
		// SOI, APP0 length 4, then SOF0 with height 100 and width 50.
		const jpeg = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 100, 0, 50, 3, 1, 0x11, 0,
		]);
		expect(readImageHeader(jpeg)).toEqual({ mime: "image/jpeg", width: 50, height: 100 });
		const webp = Buffer.alloc(30);
		webp.write("RIFF", 0, "latin1");
		webp.writeUInt32LE(22, 4);
		webp.write("WEBPVP8X", 8, "latin1");
		webp.writeUIntLE(99, 24, 3);
		webp.writeUIntLE(49, 27, 3);
		expect(readImageHeader(webp)).toEqual({ mime: "image/webp", width: 100, height: 50 });
		expect(readImageHeader(Buffer.from("not an image"))).toBeUndefined();
	});
});

describe("image cache", () => {
	let db: Db;
	let root: string;
	let cacheRoot: string;
	let backend: ReturnType<typeof createLibraryBackend>;
	let limits: ImageCacheLimits;
	let cache: ImageCache;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		root = await mkdtemp(join(tmpdir(), "crhs-image-cache-"));
		cacheRoot = join(root, "image-cache");
		backend = createLibraryBackend({ backend: "local" }, join(root, "library"));
		limits = { diskBytes: 1024 * 1024, ttlMs: 7 * 24 * 60 * 60 * 1000 };
		cache = new ImageCache(db, cacheRoot, () => limits);
	});

	afterEach(async () => {
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});

	/** Reads a cache file from its two-character shard. */
	const cacheBytes = (key: string): Promise<Buffer> => readFile(join(cacheRoot, key.slice(0, 2), key));

	it("keeps the image on local disk and serves it after a restart", async () => {
		const image = png(800, 600, 10);
		const digest = sha(image);
		await cache.put(digest, "image/png", image);
		expect(await cache.get(digest)).toMatchObject({ mime: "image/png", bytes: image });
		expect(await cacheBytes(digest)).toEqual(image);

		const reopened = new ImageCache(db, cacheRoot, () => limits);
		expect(await reopened.get(digest)).toMatchObject({ mime: "image/png", bytes: image });
	});

	it("keeps stored_at from a restored result and moves only last_used_at on a hit", async () => {
		const image = png(800, 600, 10);
		const digest = sha(image);
		const storedAt = Date.now() - 60 * 60 * 1000;
		await cache.put(digest, "image/png", image, storedAt);
		expect(await cache.storedAt(digest)).toBe(storedAt);
		// A repeated put keeps the entry's own stored_at: the bytes never left the disk.
		await cache.put(digest, "image/png", image, storedAt + 1000);
		expect(await cache.storedAt(digest)).toBe(storedAt);

		const oldUse = new Date(storedAt).toISOString();
		await db.updateTable("image_cache").set({ last_used_at: oldUse }).where("sha256", "=", digest).execute();
		expect(await cache.get(digest)).toMatchObject({ bytes: image });
		const row = await db
			.selectFrom("image_cache")
			.select(["last_used_at", "stored_at"])
			.where("sha256", "=", digest)
			.executeTakeFirstOrThrow();
		expect(row.stored_at).toBe(oldUse);
		expect(Date.parse(row.last_used_at)).toBeGreaterThan(storedAt);
	});

	it("sweeps rows and objects by age and size", async () => {
		const one = png(1, 1, 500);
		const two = png(2, 2, 500);
		const oneSha = sha(one);
		const twoSha = sha(two);
		await cache.put(oneSha, "image/png", one);
		await cache.put(twoSha, "image/png", two);

		limits.diskBytes = one.length;
		await cache.sweep();
		await expect(cacheBytes(oneSha)).rejects.toThrow();
		expect(await cacheBytes(twoSha)).toEqual(two);
		expect(await db.selectFrom("image_cache").select("sha256").execute()).toEqual([{ sha256: twoSha }]);

		const later = Date.now() + limits.ttlMs + 1000;
		limits.diskBytes = 1024 * 1024;
		await cache.sweep(later);
		expect(await db.selectFrom("image_cache").select("sha256").execute()).toEqual([]);
		await expect(cacheBytes(twoSha)).rejects.toThrow();
	});

	it("does not treat cache objects as library orphans", async () => {
		const image = png(1, 1, 10);
		await cache.put(sha(image), "image/png", image);
		expect(await sweepLibraryOrphans(db, backend)).toBe(0);
		expect(await cacheBytes(sha(image))).toEqual(image);
	});

	it("sweeps a stale cache part file", async () => {
		const key = sha(png(1, 1, 10));
		const directory = join(cacheRoot, key.slice(0, 2));
		const part = join(directory, `${key}.crh-part-abcdef123456`);
		await mkdir(directory, { recursive: true });
		await writeFile(part, "partial");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(part, old, old);
		await cache.sweep();
		await expect(readFile(part)).rejects.toThrow();
	});
});

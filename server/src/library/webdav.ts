/**
 * The WebDAV library backend (doc/design/library.md "Backends"): objects in one collection hierarchy,
 * reached with PUT, GET, DELETE and PROPFIND. No dependency; the requests are plain fetch calls.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { LibraryConfig } from "../config.ts";
import { checkCacheKey, checkObjectKey, type LibraryBackend, type LibraryObject, objectShard } from "./backend.ts";

type WebdavConfig = Extract<LibraryConfig, { backend: "webdav" }>;

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>`;

/** The object-key shape of this backend; other files in the collection are not ours and stay put. */
const OBJECT_KEY_RE = /^[0-9a-f]{32}$/;
const CACHE_KEY_RE = /^[0-9a-f]{64}$/;

/** One entry of a PROPFIND response: where it is and, when the server reports it, when it changed. */
interface DavEntry {
	url: URL;
	lastModified?: number;
}

export function createWebdavBackend(config: WebdavConfig): LibraryBackend {
	return new WebdavLibraryBackend(config);
}

class WebdavLibraryBackend implements LibraryBackend {
	readonly kind = "webdav";
	readonly #base: URL;
	readonly #authorization: string;
	#collection: Promise<void> | undefined;
	#cacheCollection: Promise<void> | undefined;

	constructor(config: WebdavConfig) {
		this.#base = new URL(config.url);
		if (!this.#base.pathname.endsWith("/")) this.#base.pathname += "/";
		this.#authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
	}

	#objectUrl(key: string): URL {
		const name = checkObjectKey(key);
		return new URL(`${objectShard(name)}/${name}`, this.#base);
	}

	#cacheUrl(key: string): URL {
		const name = checkCacheKey(key);
		return new URL(`cache/${objectShard(name)}/${name}`, this.#base);
	}

	#cacheRoot(): URL {
		return new URL("cache/", this.#base);
	}

	async #fetch(url: URL, init: RequestInit = {}): Promise<Response> {
		return fetch(url, {
			...init,
			headers: { ...init.headers, authorization: this.#authorization },
		});
	}

	/** Creates the collection once; a WebDAV server answers 405 when it already exists. */
	#ensureCollection(): Promise<void> {
		this.#collection ??= this.#mkcol(this.#base);
		return this.#collection;
	}

	/** Creates the cache collection once, below the library collection. */
	#ensureCacheCollection(): Promise<void> {
		this.#cacheCollection ??= (async () => {
			await this.#ensureCollection();
			await this.#mkcol(this.#cacheRoot());
		})();
		return this.#cacheCollection;
	}

	/** A MKCOL that treats 405 as "already exists"; that is how a generic WebDAV server answers it. */
	async #mkcol(url: URL): Promise<void> {
		const response = await this.#fetch(url, { method: "MKCOL" });
		if (response.status !== 201 && response.status !== 200 && response.status !== 405) {
			throw new Error(`library WebDAV: MKCOL ${url} failed with ${response.status}`);
		}
	}

	/** Creates a key's shard collection; empty shards are left in place (doc/design/library.md "Backends"). */
	async #ensureShard(collection: URL, key: string): Promise<void> {
		await this.#mkcol(new URL(`${objectShard(key)}/`, collection));
	}

	async put(key: string, source: Readable): Promise<{ size: number; sha256: string }> {
		const url = this.#objectUrl(key);
		await this.#ensureCollection();
		await this.#ensureShard(this.#base, key);
		const hash = createHash("sha256");
		let size = 0;
		async function* counted(): AsyncGenerator<Uint8Array> {
			for await (const chunk of source) {
				const bytes = Buffer.from(chunk);
				size += bytes.length;
				hash.update(bytes);
				yield bytes;
			}
		}
		const body = Readable.toWeb(Readable.from(counted())) as WebReadableStream<Uint8Array>;
		const response = await this.#fetch(url, {
			method: "PUT",
			headers: { "content-type": "application/octet-stream" },
			body,
			duplex: "half",
		} as RequestInit);
		if (!response.ok) throw new Error(`library WebDAV: PUT ${key} failed with ${response.status}`);
		return { size, sha256: hash.digest("hex") };
	}

	get(key: string): Readable {
		return Readable.from(this.#get(key));
	}

	async *#get(key: string): AsyncGenerator<Uint8Array> {
		const response = await this.#fetch(this.#objectUrl(key));
		if (!response.ok || response.body === null) {
			throw new Error(`library WebDAV: GET ${key} failed with ${response.status}`);
		}
		for await (const chunk of response.body) yield chunk;
	}

	async delete(key: string): Promise<void> {
		const response = await this.#fetch(this.#objectUrl(key), { method: "DELETE" });
		if (!response.ok && response.status !== 404) {
			throw new Error(`library WebDAV: DELETE ${key} failed with ${response.status}`);
		}
	}

	async putCache(key: string, source: Readable): Promise<{ size: number; sha256: string }> {
		const url = this.#cacheUrl(key);
		await this.#ensureCacheCollection();
		await this.#ensureShard(this.#cacheRoot(), key);
		const hash = createHash("sha256");
		let size = 0;
		async function* counted(): AsyncGenerator<Uint8Array> {
			for await (const chunk of source) {
				const bytes = Buffer.from(chunk);
				size += bytes.length;
				hash.update(bytes);
				yield bytes;
			}
		}
		const body = Readable.toWeb(Readable.from(counted())) as WebReadableStream<Uint8Array>;
		const response = await this.#fetch(url, {
			method: "PUT",
			headers: { "content-type": "application/octet-stream" },
			body,
			duplex: "half",
		} as RequestInit);
		if (!response.ok) throw new Error(`library WebDAV: PUT cache failed with ${response.status}`);
		return { size, sha256: hash.digest("hex") };
	}

	getCache(key: string): Readable {
		return Readable.from(this.#getCache(key));
	}

	async *#getCache(key: string): AsyncGenerator<Uint8Array> {
		const response = await this.#fetch(this.#cacheUrl(key));
		if (!response.ok || response.body === null) {
			throw new Error(`library WebDAV: GET cache failed with ${response.status}`);
		}
		for await (const chunk of response.body) yield chunk;
	}

	async deleteCache(key: string): Promise<void> {
		const response = await this.#fetch(this.#cacheUrl(key), { method: "DELETE" });
		if (!response.ok && response.status !== 404) {
			throw new Error(`library WebDAV: DELETE cache failed with ${response.status}`);
		}
	}

	async *listCache(): AsyncIterable<LibraryObject> {
		yield* this.#listSharded(this.#cacheRoot(), CACHE_KEY_RE);
	}

	async *list(): AsyncIterable<LibraryObject> {
		yield* this.#listSharded(this.#base, OBJECT_KEY_RE);
	}

	/** Lists each two-hex-character shard's objects with Depth: 1 (doc/design/library.md "Backends"). */
	async *#listSharded(collection: URL, keyPattern: RegExp): AsyncIterable<LibraryObject> {
		for (const shard of await this.#shards(collection)) {
			for (const entry of await this.#propfind(shard)) {
				const key = decodeURIComponent(entry.url.pathname.slice(shard.pathname.length)).replace(/\/$/, "");
				if (!keyPattern.test(key)) continue;
				yield {
					key,
					...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
				};
			}
		}
	}

	/** The immediate sub-collections of `collection` whose name is two hex characters, one shard level. */
	async #shards(collection: URL): Promise<URL[]> {
		const shards: URL[] = [];
		for (const entry of await this.#propfind(collection)) {
			const relative = decodeURIComponent(entry.url.pathname.slice(collection.pathname.length));
			if (!/^[0-9a-f]{2}\/?$/.test(relative)) continue;
			shards.push(new URL(relative.endsWith("/") ? relative : `${relative}/`, collection));
		}
		return shards;
	}

	/**
	 * One collection's immediate entries. Depth is always 1: many servers refuse `Depth: infinity`, and the
	 * sweep walks the shard level itself. A missing collection has no entries.
	 */
	async #propfind(url: URL): Promise<DavEntry[]> {
		const response = await this.#fetch(url, {
			method: "PROPFIND",
			headers: { depth: "1", "content-type": "application/xml" },
			body: PROPFIND_BODY,
		});
		if (response.status === 404) return [];
		if (!response.ok) throw new Error(`library WebDAV: PROPFIND ${url} failed with ${response.status}`);
		const text = await response.text();
		const entries: DavEntry[] = [];
		for (const match of text.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g)) {
			const block = match[1] ?? "";
			const href = /<(?:[\w-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w-]+:)?href>/.exec(block)?.[1];
			if (href === undefined) continue;
			let entryUrl: URL;
			try {
				entryUrl = new URL(decodeXml(href.trim()), url);
			} catch {
				continue;
			}
			const modified = /<(?:[\w-]+:)?getlastmodified\b[^>]*>([^<]*)<\/(?:[\w-]+:)?getlastmodified>/.exec(block)?.[1];
			const lastModified = modified === undefined ? undefined : Date.parse(decodeXml(modified.trim()));
			entries.push({
				url: entryUrl,
				...(lastModified === undefined || Number.isNaN(lastModified) ? {} : { lastModified }),
			});
		}
		return entries;
	}
}

/** The few XML entities a WebDAV href or date may carry. */
function decodeXml(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'");
}

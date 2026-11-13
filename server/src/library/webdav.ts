/**
 * The WebDAV library backend (doc/design/library.md "Backends"): objects in one collection, reached
 * with PUT, GET, DELETE and PROPFIND. No dependency; the requests are plain fetch calls.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { LibraryConfig } from "../config.ts";
import type { LibraryBackend, LibraryObject } from "./backend.ts";

type WebdavConfig = Extract<LibraryConfig, { backend: "webdav" }>;

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>`;

/** The object-key shape of this backend; other files in the collection are not ours and stay put. */
const OBJECT_KEY_RE = /^[0-9a-f]{32}$/;

export function createWebdavBackend(config: WebdavConfig): LibraryBackend {
	return new WebdavLibraryBackend(config);
}

class WebdavLibraryBackend implements LibraryBackend {
	readonly kind = "webdav";
	readonly #base: URL;
	readonly #authorization: string;
	#collection: Promise<void> | undefined;

	constructor(config: WebdavConfig) {
		this.#base = new URL(config.url);
		if (!this.#base.pathname.endsWith("/")) this.#base.pathname += "/";
		this.#authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
	}

	#objectUrl(key: string): URL {
		return new URL(encodeURIComponent(key), this.#base);
	}

	async #fetch(url: URL, init: RequestInit = {}): Promise<Response> {
		return fetch(url, {
			...init,
			headers: { ...init.headers, authorization: this.#authorization },
		});
	}

	/** Creates the collection once; a WebDAV server answers 405 when it already exists. */
	#ensureCollection(): Promise<void> {
		this.#collection ??= (async () => {
			const response = await this.#fetch(this.#base, { method: "MKCOL" });
			if (response.status !== 201 && response.status !== 405 && response.status !== 200) {
				throw new Error(`library WebDAV: MKCOL ${this.#base} failed with ${response.status}`);
			}
		})();
		return this.#collection;
	}

	async put(key: string, source: Readable): Promise<{ size: number; sha256: string }> {
		await this.#ensureCollection();
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
		const response = await this.#fetch(this.#objectUrl(key), {
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

	async *list(): AsyncIterable<LibraryObject> {
		const response = await this.#fetch(this.#base, {
			method: "PROPFIND",
			headers: { depth: "1", "content-type": "application/xml" },
			body: PROPFIND_BODY,
		});
		if (!response.ok) throw new Error(`library WebDAV: PROPFIND ${this.#base} failed with ${response.status}`);
		const text = await response.text();
		for (const match of text.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g)) {
			const block = match[1] ?? "";
			const href = /<(?:[\w-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w-]+:)?href>/.exec(block)?.[1];
			if (href === undefined) continue;
			let url: URL;
			try {
				url = new URL(decodeXml(href.trim()), this.#base);
			} catch {
				continue;
			}
			const key = decodeURIComponent(url.pathname.slice(this.#base.pathname.length)).replace(/\/$/, "");
			if (!OBJECT_KEY_RE.test(key)) continue;
			const modified = /<(?:[\w-]+:)?getlastmodified\b[^>]*>([^<]*)<\/(?:[\w-]+:)?getlastmodified>/.exec(block)?.[1];
			const lastModified = modified === undefined ? undefined : Date.parse(decodeXml(modified.trim()));
			yield {
				key,
				...(lastModified === undefined || Number.isNaN(lastModified) ? {} : { lastModified }),
			};
		}
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

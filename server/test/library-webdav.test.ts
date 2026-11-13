import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibraryBackend, getBytes, type LibraryObject, putBytes } from "../src/library/backend.ts";

const BASE_PATH = "/dav/";
const KEY = "a".repeat(32);
const CACHE_KEY = "c".repeat(64);

/** A tiny in-process WebDAV collection: MKCOL, PUT, GET, DELETE and Depth-1 PROPFIND over collections and a Map. */
function startWebdav() {
	const collections = new Set<string>([""]);
	const objects = new Map<string, { data: Buffer; lastModified: number }>();
	const methods: string[] = [];
	const depths: string[] = [];
	const entry = (name: string, lastModified?: number): string =>
		`<D:response><D:href>${BASE_PATH}${name}</D:href><D:propstat><D:prop>` +
		(lastModified === undefined
			? ""
			: `<D:getlastmodified>${new Date(lastModified).toUTCString()}</D:getlastmodified>`) +
		`</D:prop></D:propstat></D:response>`;
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		methods.push(req.method ?? "");
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.pathname.startsWith(BASE_PATH)) {
			res.writeHead(404).end();
			return;
		}
		const relative = decodeURIComponent(url.pathname.slice(BASE_PATH.length)).replace(/\/$/, "");
		const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
		if (req.method === "MKCOL") {
			if (!collections.has(parent)) res.writeHead(409).end();
			else if (collections.has(relative)) res.writeHead(405).end();
			else {
				collections.add(relative);
				res.writeHead(201).end();
			}
			return;
		}
		if (req.method === "PUT") {
			if (!collections.has(parent)) {
				res.writeHead(409).end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			objects.set(relative, { data: Buffer.concat(chunks), lastModified: Date.now() });
			res.writeHead(201).end();
			return;
		}
		if (req.method === "GET") {
			const object = objects.get(relative);
			if (!object) res.writeHead(404).end();
			else res.writeHead(200, { "content-type": "application/octet-stream" }).end(object.data);
			return;
		}
		if (req.method === "DELETE") {
			objects.delete(relative);
			res.writeHead(204).end();
			return;
		}
		if (req.method === "PROPFIND") {
			if (!collections.has(relative)) {
				res.writeHead(404).end();
				return;
			}
			depths.push(String(req.headers.depth));
			if (req.headers.depth === "infinity") {
				res.writeHead(403).end();
				return;
			}
			const responses = [entry(relative === "" ? "" : `${relative}/`)];
			for (const collection of collections) {
				const above = collection.includes("/") ? collection.slice(0, collection.lastIndexOf("/")) : "";
				if (collection !== relative && above === relative) responses.push(entry(`${collection}/`));
			}
			for (const [name, object] of objects) {
				const above = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
				if (above === relative) responses.push(entry(name, object.lastModified));
			}
			res.writeHead(207, { "content-type": "application/xml" });
			res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`);
			return;
		}
		res.writeHead(405).end();
	});
	return {
		server,
		collections,
		objects,
		methods,
		depths,
		async start(): Promise<string> {
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const port = (server.address() as AddressInfo).port;
			return `http://127.0.0.1:${port}${BASE_PATH}`;
		},
	};
}

describe("WebDAV library backend", () => {
	let fake: ReturnType<typeof startWebdav>;
	let url = "";
	let backend: ReturnType<typeof createLibraryBackend>;

	beforeEach(async () => {
		fake = startWebdav();
		url = await fake.start();
		backend = createLibraryBackend(
			{ backend: "webdav", url, username: "crh", password: "secret" },
			join(tmpdir(), "unused"),
		);
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => fake.server.close(() => resolve()));
	});

	it("creates shard collections, stores, lists and deletes objects", async () => {
		const data = Buffer.from("webdav content");
		const shard = KEY.slice(0, 2);
		const stored = await putBytes(backend, KEY, data);
		expect(stored).toEqual({ size: data.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(fake.methods).toContain("MKCOL");
		expect(fake.collections).toEqual(new Set(["", shard]));
		expect(fake.objects.get(`${shard}/${KEY}`)?.data).toEqual(data);

		expect(await getBytes(backend, KEY)).toEqual(data);
		const listed: LibraryObject[] = [];
		for await (const object of backend.list()) listed.push(object);
		expect(listed.map((object) => object.key)).toEqual([KEY]);
		expect(listed[0]?.lastModified).toBeTypeOf("number");
		expect(fake.depths.every((depth) => depth === "1")).toBe(true);

		await backend.delete(KEY);
		expect(fake.objects.has(`${shard}/${KEY}`)).toBe(false);
	});

	it("stores and lists cache objects in a sharded cache collection", async () => {
		const data = Buffer.from("cached image");
		const shard = CACHE_KEY.slice(0, 2);
		await backend.putCache(CACHE_KEY, Readable.from([data]));
		expect(fake.collections).toEqual(new Set(["", "cache", `cache/${shard}`]));
		expect(fake.objects.get(`cache/${shard}/${CACHE_KEY}`)?.data).toEqual(data);

		const listed: LibraryObject[] = [];
		for await (const object of backend.listCache()) listed.push(object);
		expect(listed.map((object) => object.key)).toEqual([CACHE_KEY]);

		await backend.deleteCache(CACHE_KEY);
		expect(fake.objects.has(`cache/${shard}/${CACHE_KEY}`)).toBe(false);
	});
});

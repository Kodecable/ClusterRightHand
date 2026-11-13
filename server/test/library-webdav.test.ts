import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibraryBackend, getBytes, type LibraryObject, putBytes } from "../src/library/backend.ts";

const BASE_PATH = "/dav/";
const KEY = "a".repeat(32);

/** A tiny in-process WebDAV collection: MKCOL, PUT, GET, DELETE and PROPFIND over a Map. */
function startWebdav() {
	const objects = new Map<string, { data: Buffer; lastModified: number }>();
	const methods: string[] = [];
	let collection = false;
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		methods.push(req.method ?? "");
		const url = new URL(req.url ?? "/", "http://localhost");
		if (!url.pathname.startsWith(BASE_PATH)) {
			res.writeHead(404).end();
			return;
		}
		const key = decodeURIComponent(url.pathname.slice(BASE_PATH.length)).replace(/\/$/, "");
		if (req.method === "MKCOL") {
			if (collection) res.writeHead(405).end();
			else {
				collection = true;
				res.writeHead(201).end();
			}
			return;
		}
		if (!collection) {
			res.writeHead(409).end();
			return;
		}
		if (req.method === "PUT") {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			objects.set(key, { data: Buffer.concat(chunks), lastModified: Date.now() });
			res.writeHead(201).end();
			return;
		}
		if (req.method === "GET") {
			const object = objects.get(key);
			if (!object) res.writeHead(404).end();
			else {
				res.writeHead(200, { "content-type": "application/octet-stream" }).end(object.data);
			}
			return;
		}
		if (req.method === "DELETE") {
			objects.delete(key);
			res.writeHead(204).end();
			return;
		}
		if (req.method === "PROPFIND") {
			const responses = [...objects.entries()]
				.map(
					([name, object]) =>
						`<D:response><D:href>${BASE_PATH}${name}</D:href>` +
						`<D:propstat><D:prop><D:getlastmodified>${new Date(object.lastModified).toUTCString()}</D:getlastmodified></D:prop></D:propstat></D:response>`,
				)
				.join("");
			res.writeHead(207, { "content-type": "application/xml" });
			res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`);
			return;
		}
		res.writeHead(405).end();
	});
	return {
		server,
		objects,
		methods,
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

	it("creates the collection, stores, lists and deletes objects", async () => {
		const data = Buffer.from("webdav content");
		const stored = await putBytes(backend, KEY, data);
		expect(stored).toEqual({ size: data.length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
		expect(fake.methods).toContain("MKCOL");
		expect(fake.objects.get(KEY)?.data).toEqual(data);

		expect(await getBytes(backend, KEY)).toEqual(data);
		const listed: LibraryObject[] = [];
		for await (const object of backend.list()) listed.push(object);
		expect(listed.map((object) => object.key)).toEqual([KEY]);
		expect(listed[0]?.lastModified).toBeTypeOf("number");

		await backend.delete(KEY);
		expect(fake.objects.has(KEY)).toBe(false);
	});
});

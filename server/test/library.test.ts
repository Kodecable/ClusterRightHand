import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { LibraryFile, LibraryFilesResponse, LibraryListResponse } from "@crh/api";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibraryBackend, getBytes, putBytes } from "../src/library/backend.ts";
import { beginLibraryUpload } from "../src/library/files.ts";
import { findLibraryByRef } from "../src/library/library.ts";
import { MediaProbe } from "../src/library/media-type.ts";
import { numberedLibraryPath, validateLibraryPath } from "../src/library/paths.ts";
import { sweepLibraryOrphans } from "../src/library/sweep.ts";
import { defaultSystemSettings, SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { NotFoundError } from "../src/util/errors.ts";
import { call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

describe("library paths", () => {
	it("accepts flat keys and refuses everything else", () => {
		expect(validateLibraryPath("docs/a.txt")).toBe("docs/a.txt");
		expect(validateLibraryPath("a b/ünïcode.png")).toBe("a b/ünïcode.png");
		for (const bad of ["", "/a", "a/", "a//b", "a/./b", "a/../b", "a\u0000b", `x/${"a".repeat(1100)}`]) {
			expect(() => validateLibraryPath(bad), bad).toThrow();
		}
	});

	it("numbers a renamed upload before the first dot of the base name", () => {
		expect(numberedLibraryPath("x.tar.gz", 1)).toBe("x (1).tar.gz");
		expect(numberedLibraryPath("photo.png", 1)).toBe("photo (1).png");
		expect(numberedLibraryPath(".bashrc", 1)).toBe(".bashrc (1)");
		expect(numberedLibraryPath("Makefile", 1)).toBe("Makefile (1)");
		expect(numberedLibraryPath("attachments/2026-01/x.tar.gz", 2)).toBe("attachments/2026-01/x (2).tar.gz");
	});
});

describe("media type sniffing", () => {
	const sniff = (data: Uint8Array): string => {
		const probe = new MediaProbe();
		probe.push(data);
		return probe.finish();
	};

	it("recognizes the image types and PDF from magic bytes", () => {
		expect(sniff(Buffer.from("89504e470d0a1a0a72657374", "hex"))).toBe("image/png");
		expect(sniff(Buffer.from("ffd8ff72657374", "hex"))).toBe("image/jpeg");
		expect(sniff(Buffer.from("GIF89arest"))).toBe("image/gif");
		expect(sniff(Buffer.from("RIFF1234WEBPrest"))).toBe("image/webp");
		expect(sniff(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
	});

	it("calls valid UTF-8 without NUL text and everything else binary", () => {
		expect(sniff(Buffer.from("hello, 世界"))).toBe("text/plain");
		expect(sniff(Buffer.from([0x68, 0x00, 0x69]))).toBe("application/octet-stream");
		expect(sniff(Buffer.from([0xff, 0xfe]))).toBe("application/octet-stream");
	});
});

describe("local library backend", () => {
	it("rejects a put whose write stream fails without crashing on an unhandled error", async () => {
		const root = await mkdtemp(join(tmpdir(), "crhs-local-backend-"));
		try {
			const backend = createLibraryBackend({ backend: "local" }, root);
			const key = `ab${"0".repeat(30)}`;
			// A read-only shard makes the destination's open fail as ENOSPC or EACCES would while the
			// source is still being read. A put that does not own the write stream's error crashes here.
			await mkdir(join(root, key.slice(0, 2)), { mode: 0o500 });
			await expect(backend.put(key, Readable.from([Buffer.alloc(64 * 1024, 7)]))).rejects.toMatchObject({
				code: "EACCES",
			});
			expect(await readdir(join(root, key.slice(0, 2)))).toEqual([]);
			await expect(getBytes(backend, key)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("library API", () => {
	let db: Db;
	let root: string;
	let backend: ReturnType<typeof createLibraryBackend>;
	let app: ReturnType<typeof makeApp>;
	let admin: string;
	let alice: string;
	let bob: string;
	let aliceId: string;
	let adminId: string;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		root = await mkdtemp(join(tmpdir(), "crhs-library-"));
		backend = createLibraryBackend({ backend: "local" }, root);
		app = makeApp(db, undefined, { libraryBackend: backend });
		adminId = (await createUser(db, { username: "root", kind: "admin", password: "root-password" })).id;
		aliceId = (await createUser(db, { username: "alice", kind: "member", password: "alice-password" })).id;
		await createUser(db, { username: "bob", kind: "member", password: "bob-password" });
		admin = await login(app, "root", "root-password");
		alice = await login(app, "alice", "alice-password");
		bob = await login(app, "bob", "bob-password");
	});

	afterEach(async () => {
		await db.destroy();
		await rm(root, { recursive: true, force: true });
	});

	const lib = (ref: string): string => `/api/libraries/${encodeURIComponent(ref)}`;

	const upload = (
		cookie: string,
		ref: string,
		path: string,
		data: Uint8Array,
		options: { overwrite?: boolean; preview?: boolean; rename?: boolean } = {},
	) => {
		const query = new URLSearchParams({ path });
		if (options.overwrite) query.set("overwrite", "1");
		if (options.preview) query.set("preview", "1");
		if (options.rename) query.set("rename", "1");
		return app.request(`${lib(ref)}/file?${query}`, {
			method: "PUT",
			headers: { host: "localhost:8080", cookie, "content-type": "application/octet-stream" },
			body: data,
		});
	};

	const list = async (cookie: string, ref: string, prefix = ""): Promise<LibraryFilesResponse> =>
		(await (
			await app.request(`${lib(ref)}/files${prefix === "" ? "" : `?prefix=${encodeURIComponent(prefix)}`}`, {
				headers: { host: "localhost:8080", cookie },
			})
		).json()) as LibraryFilesResponse;

	it("lists the caller's libraries with usage and limits", async () => {
		const response = await app.request("/api/libraries", { headers: { host: "localhost:8080", cookie: alice } });
		const body = (await response.json()) as LibraryListResponse;
		expect(body.libraries.map((library) => library.ref)).toEqual(["user:alice"]);
		expect(body.libraries[0]?.limits).toEqual({
			files: 256,
			fileBytes: 32 * 1024 * 1024,
			totalBytes: 256 * 1024 * 1024,
		});
		expect(body.libraries[0]?.capabilities).toEqual({ write: true, manage: false });

		const adminView = await app.request("/api/libraries", { headers: { host: "localhost:8080", cookie: admin } });
		expect(((await adminView.json()) as LibraryListResponse).libraries.map((library) => library.ref)).toEqual([
			"user:root",
		]);
	});

	it("uploads, lists by prefix, stats, downloads, renames and deletes", async () => {
		const data = Buffer.from("hello world\n");
		const uploaded = await upload(alice, "user:alice", "docs/notes/a.txt", data);
		expect(uploaded.status).toBe(201);
		const file = ((await uploaded.json()) as { file: LibraryFile }).file;
		expect(file).toMatchObject({
			path: "docs/notes/a.txt",
			size: data.length,
			sha256: sha256Hex(data),
			mediaType: "text/plain",
		});

		const rootListing = await list(alice, "user:alice");
		expect(rootListing.files).toEqual([]);
		expect(rootListing.directories).toEqual(["docs"]);
		const docs = await list(alice, "user:alice", "docs");
		expect(docs.directories).toEqual(["notes"]);
		const notes = await list(alice, "user:alice", "docs/notes");
		expect(notes.files.map((entry) => entry.path)).toEqual(["docs/notes/a.txt"]);

		const stat = await app.request(`${lib("user:alice")}/stat?path=docs/notes/a.txt`, {
			headers: { host: "localhost:8080", cookie: alice },
		});
		expect(stat.status).toBe(200);

		const download = await app.request(`${lib("user:alice")}/file?path=docs/notes/a.txt`, {
			headers: { host: "localhost:8080", cookie: alice },
		});
		expect(download.status).toBe(200);
		expect(download.headers.get("x-content-type-options")).toBe("nosniff");
		expect(download.headers.get("content-security-policy")).toBe("sandbox");
		expect(download.headers.get("content-disposition")).toContain("attachment");
		expect(Buffer.from(await download.arrayBuffer()).toString()).toBe("hello world\n");

		const moved = await call(app, `${lib("user:alice")}/move`, {
			cookie: alice,
			body: { from: "docs/notes/a.txt", to: "archive/renamed.txt" },
		});
		expect(moved.status).toBe(200);
		expect(await list(alice, "user:alice", "archive")).toMatchObject({ directories: [] });

		const library = (await (
			await app.request(lib("user:alice"), { headers: { host: "localhost:8080", cookie: alice } })
		).json()) as { library: { usage: { files: number; bytes: number } } };
		expect(library.library.usage).toEqual({ files: 1, bytes: data.length });

		const deleted = await app.request(`${lib("user:alice")}/file?path=archive/renamed.txt`, {
			method: "DELETE",
			headers: { host: "localhost:8080", cookie: alice, "content-type": "application/json" },
			body: "{}",
		});
		expect(deleted.status).toBe(200);
		expect((await list(alice, "user:alice")).files).toEqual([]);
	});

	it("overwrites a file atomically and removes the replaced object", async () => {
		expect((await upload(alice, "user:alice", "replace.txt", Buffer.from("old"))).status).toBe(201);
		const first = await db
			.selectFrom("library_files")
			.select(["object_key", "size"])
			.where("path", "=", "replace.txt")
			.executeTakeFirstOrThrow();
		const backend = createLibraryBackend({ backend: "local" }, root);

		expect((await upload(alice, "user:alice", "replace.txt", Buffer.from("newer"), { overwrite: true })).status).toBe(
			201,
		);
		const second = await db
			.selectFrom("library_files")
			.select(["object_key", "size", "sha256"])
			.where("path", "=", "replace.txt")
			.executeTakeFirstOrThrow();
		expect(second.size).toBe(5);
		expect(second.object_key).not.toBe(first.object_key);
		expect(await getBytes(backend, second.object_key)).toEqual(Buffer.from("newer"));
		await expect(getBytes(backend, first.object_key)).rejects.toThrow();
		const library = await db
			.selectFrom("libraries")
			.select(["used_files", "used_bytes"])
			.where("owner_kind", "=", "user")
			.where("owner_id", "=", aliceId)
			.executeTakeFirstOrThrow();
		expect(library).toEqual({ used_files: 1, used_bytes: 5 });
	});

	it("keeps used_bytes at the final size and one object when two overwrites race", async () => {
		expect((await upload(alice, "user:alice", "race.txt", Buffer.from("old"))).status).toBe(201);
		const contents = [Buffer.from("first"), Buffer.from("second!!")];
		const responses = await Promise.all(
			contents.map((data) => upload(alice, "user:alice", "race.txt", data, { overwrite: true })),
		);
		expect(responses.map((response) => response.status)).toEqual([201, 201]);

		const library = await db
			.selectFrom("libraries")
			.select("id")
			.where("owner_kind", "=", "user")
			.where("owner_id", "=", aliceId)
			.executeTakeFirstOrThrow();
		const row = await db
			.selectFrom("library_files")
			.select(["size", "object_key"])
			.where("library_id", "=", library.id)
			.where("path", "=", "race.txt")
			.executeTakeFirstOrThrow();
		// The second commit's byte delta is read under the library row lock, so usage matches the file
		// that survived and the object the first commit replaced was deleted rather than leaked.
		expect(contents.map((data) => data.length)).toContain(row.size);
		expect(await getBytes(backend, row.object_key)).toHaveLength(row.size);
		expect(
			await db
				.selectFrom("libraries")
				.select(["used_files", "used_bytes"])
				.where("id", "=", library.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ used_files: 1, used_bytes: row.size });
		const objects: string[] = [];
		for await (const object of backend.list()) objects.push(object.key);
		expect(objects).toEqual([row.object_key]);
	});

	it("serves only PNG, JPEG, GIF and WebP inline and only for a preview", async () => {
		const png = Buffer.from("\x89PNG\r\n\x1a\n0123456789", "latin1");
		expect((await upload(alice, "user:alice", "pic.png", png)).status).toBe(201);
		const preview = await app.request(`${lib("user:alice")}/file?path=pic.png&preview=1`, {
			headers: { host: "localhost:8080", cookie: alice },
		});
		expect(preview.headers.get("content-type")).toBe("image/png");
		expect(preview.headers.get("content-disposition")).toContain("inline");

		const plain = await app.request(`${lib("user:alice")}/file?path=pic.png`, {
			headers: { host: "localhost:8080", cookie: alice },
		});
		expect(plain.headers.get("content-disposition")).toContain("attachment");
	});

	it("refuses another member's library with 404 and lets an administrator reach it", async () => {
		const denied = await app.request(lib("user:alice"), { headers: { host: "localhost:8080", cookie: bob } });
		expect(denied.status).toBe(404);
		const allowed = await app.request(lib("user:alice"), { headers: { host: "localhost:8080", cookie: admin } });
		expect(allowed.status).toBe(200);
	});

	it("serves a library file only to a user who can reach the library", async () => {
		expect((await upload(alice, "user:alice", "private.txt", Buffer.from("private"))).status).toBe(201);
		// The attachment chip and a copy_file delivery download through this endpoint; access is checked here.
		const denied = await app.request(`${lib("user:alice")}/file?path=private.txt`, {
			headers: { host: "localhost:8080", cookie: bob },
		});
		expect(denied.status).toBe(404);
		const allowed = await app.request(`${lib("user:alice")}/file?path=private.txt`, {
			headers: { host: "localhost:8080", cookie: alice },
		});
		expect(allowed.status).toBe(200);
		expect(Buffer.from(await allowed.arrayBuffer()).toString()).toBe("private");
	});

	it("enforces the one-file, file-count and total limits and shows which one was hit", async () => {
		const limits = await call(app, `${lib("user:alice")}/limits`, {
			method: "PATCH",
			cookie: admin,
			body: { files: 2, fileBytes: 4, totalBytes: 5 },
		});
		expect(limits.status).toBe(200);

		const tooLarge = await upload(alice, "user:alice", "big.txt", Buffer.alloc(5));
		expect(tooLarge.status).toBe(400);
		expect(await tooLarge.json()).toMatchObject({ error: expect.stringContaining("one-file size") });

		expect((await upload(alice, "user:alice", "a.txt", Buffer.from("1234"))).status).toBe(201);
		const overTotal = await upload(alice, "user:alice", "b.txt", Buffer.from("12"));
		expect(overTotal.status).toBe(400);
		expect(await overTotal.json()).toMatchObject({ error: expect.stringContaining("total size") });

		expect((await upload(alice, "user:alice", "c.txt", Buffer.from("1"))).status).toBe(201);
		const overFiles = await upload(alice, "user:alice", "d.txt", Buffer.from("1"));
		expect(overFiles.status).toBe(400);
		expect(await overFiles.json()).toMatchObject({ error: expect.stringContaining("file count") });

		// An overwrite that keeps the usage inside the limits needs no file slot.
		expect((await upload(alice, "user:alice", "a.txt", Buffer.from("12"), { overwrite: true })).status).toBe(201);
		const refusedOverwrite = await upload(alice, "user:alice", "a.txt", Buffer.from("12345"), {
			overwrite: true,
		});
		expect(refusedOverwrite.status).toBe(400);
	});

	it("renames an upload on the server when the path is taken", async () => {
		expect((await upload(alice, "user:alice", "x.tar.gz", Buffer.from("first"))).status).toBe(201);
		const second = await upload(alice, "user:alice", "x.tar.gz", Buffer.from("second"), { rename: true });
		expect(second.status).toBe(201);
		expect(((await second.json()) as { file: LibraryFile }).file.path).toBe("x (1).tar.gz");
		const third = await upload(alice, "user:alice", "x.tar.gz", Buffer.from("third"), { rename: true });
		expect(((await third.json()) as { file: LibraryFile }).file.path).toBe("x (2).tar.gz");

		expect((await upload(alice, "user:alice", ".bashrc", Buffer.from("dot"))).status).toBe(201);
		const dot = await upload(alice, "user:alice", ".bashrc", Buffer.from("dot again"), { rename: true });
		expect(((await dot.json()) as { file: LibraryFile }).file.path).toBe(".bashrc (1)");
	});

	it("renames concurrent uploads of one name without a race", async () => {
		const [first, second] = await Promise.all([
			upload(alice, "user:alice", "same.txt", Buffer.from("one"), { rename: true }),
			upload(alice, "user:alice", "same.txt", Buffer.from("two"), { rename: true }),
		]);
		expect([first.status, second.status]).toEqual([201, 201]);
		const paths = [
			((await first.json()) as { file: LibraryFile }).file.path,
			((await second.json()) as { file: LibraryFile }).file.path,
		].sort();
		expect(paths).toEqual(["same (1).txt", "same.txt"]);
		expect((await list(alice, "user:alice")).files.map((file) => file.path).sort()).toEqual(paths);
	});

	it("refuses an upload onto a directory or under a file", async () => {
		expect((await upload(alice, "user:alice", "dir/child.txt", Buffer.from("child"))).status).toBe(201);
		const ontoDirectory = await upload(alice, "user:alice", "dir", Buffer.from("not a directory"));
		expect(ontoDirectory.status).toBe(400);
		expect(await ontoDirectory.json()).toMatchObject({ error: expect.stringContaining("a directory already exists") });

		expect((await upload(alice, "user:alice", "plain.txt", Buffer.from("plain"))).status).toBe(201);
		const underFile = await upload(alice, "user:alice", "plain.txt/child.txt", Buffer.from("nested"));
		expect(underFile.status).toBe(400);
		expect(await underFile.json()).toMatchObject({ error: "a file already exists at plain.txt" });
	});

	it("numbers an upload past a directory", async () => {
		expect((await upload(alice, "user:alice", "taken/child.txt", Buffer.from("child"))).status).toBe(201);
		const renamed = await upload(alice, "user:alice", "taken", Buffer.from("renamed"), { rename: true });
		expect(renamed.status).toBe(201);
		expect(((await renamed.json()) as { file: LibraryFile }).file.path).toBe("taken (1)");
		expect((await list(alice, "user:alice")).directories).toContain("taken");
		expect((await list(alice, "user:alice")).files.map((file) => file.path)).toEqual(["taken (1)"]);
	});

	it("lets only one of a concurrent a and a/b upload win", async () => {
		const [outer, nested] = await Promise.all([
			upload(alice, "user:alice", "a", Buffer.from("a")),
			upload(alice, "user:alice", "a/b", Buffer.from("b")),
		]);
		expect([outer.status, nested.status].sort()).toEqual([201, 400]);
		const root = await list(alice, "user:alice");
		expect(root.files.length + root.directories.length).toBe(1);
	});

	it("refuses a move onto a directory or under a file", async () => {
		expect((await upload(alice, "user:alice", "dir/child.txt", Buffer.from("child"))).status).toBe(201);
		expect((await upload(alice, "user:alice", "source.txt", Buffer.from("source"))).status).toBe(201);
		expect((await upload(alice, "user:alice", "plain.txt", Buffer.from("plain"))).status).toBe(201);

		const ontoDirectory = await call(app, `${lib("user:alice")}/move`, {
			cookie: alice,
			body: { from: "source.txt", to: "dir" },
		});
		expect(ontoDirectory.status).toBe(400);
		expect(await ontoDirectory.json()).toMatchObject({ error: expect.stringContaining("a directory already exists") });

		const underFile = await call(app, `${lib("user:alice")}/move`, {
			cookie: alice,
			body: { from: "source.txt", to: "plain.txt/child.txt" },
		});
		expect(underFile.status).toBe(400);
		expect(await underFile.json()).toMatchObject({ error: "a file already exists at plain.txt" });
	});

	it("moves a file onto the directory it was under, or under its own path", async () => {
		expect((await upload(alice, "user:alice", "a/b", Buffer.from("b"))).status).toBe(201);
		// "a/b" is the only file under "a/": after the move it is "a" itself, not a directory conflict.
		const onto = await call(app, `${lib("user:alice")}/move`, { cookie: alice, body: { from: "a/b", to: "a" } });
		expect(onto.status).toBe(200);
		// "a" is the moved file itself, so it is not a conflicting ancestor of its new path.
		const under = await call(app, `${lib("user:alice")}/move`, { cookie: alice, body: { from: "a", to: "a/b" } });
		expect(under.status).toBe(200);
		expect((await list(alice, "user:alice", "a")).files.map((file) => file.path)).toEqual(["a/b"]);
	});

	it("removes the object a move overwrites", async () => {
		expect((await upload(alice, "user:alice", "new.txt", Buffer.from("new"))).status).toBe(201);
		expect((await upload(alice, "user:alice", "victim.txt", Buffer.from("old"))).status).toBe(201);
		const victim = await db
			.selectFrom("library_files")
			.select("object_key")
			.where("path", "=", "victim.txt")
			.executeTakeFirstOrThrow();
		const moved = await call(app, `${lib("user:alice")}/move`, {
			cookie: alice,
			body: { from: "new.txt", to: "victim.txt", overwrite: true },
		});
		expect(moved.status).toBe(200);
		await expect(getBytes(backend, victim.object_key)).rejects.toThrow();
	});

	it("matches listing prefixes case-sensitively", async () => {
		expect((await upload(alice, "user:alice", "Docs/a.txt", Buffer.from("upper"))).status).toBe(201);
		expect(await list(alice, "user:alice", "docs")).toEqual({ prefix: "docs", files: [], directories: [] });
		// The conflict check is case-sensitive too: "docs" is not the directory "Docs".
		expect((await upload(alice, "user:alice", "docs", Buffer.from("lower"))).status).toBe(201);
	});

	it("fails an upload whose backend stops reading instead of hanging", async () => {
		const broken = createLibraryBackend({ backend: "local" }, root);
		broken.put = async (_key, source) => {
			for await (const _chunk of source) throw new Error("disk full");
			return { size: 0, sha256: "" };
		};
		const brokenApp = makeApp(db, undefined, { libraryBackend: broken });
		const response = await brokenApp.request(`${lib("user:alice")}/file?path=stalled.bin`, {
			method: "PUT",
			headers: { host: "localhost:8080", cookie: alice, "content-type": "application/octet-stream" },
			body: Buffer.alloc(64 * 1024, 7),
		});
		expect(response.status).toBe(500);
		expect(await db.selectFrom("library_files").select("path").where("path", "=", "stalled.bin").execute()).toEqual([]);
	});

	it("reports a library that vanished before the commit as not found", async () => {
		const record = await findLibraryByRef(db, "user:alice");
		if (!record) throw new Error("no alice library");
		const uploader = beginLibraryUpload(db, backend, {
			library: record.row,
			path: "gone.txt",
			overwrite: false,
			createdBy: aliceId,
		});
		await uploader.write(Buffer.from("x"));
		await db.deleteFrom("libraries").where("id", "=", record.row.id).execute();
		await expect(uploader.commit()).rejects.toBeInstanceOf(NotFoundError);
		await uploader.discard();
	});

	it("frees a file's slot once when two deletes race", async () => {
		expect((await upload(alice, "user:alice", "once.txt", Buffer.from("abc"))).status).toBe(201);
		const remove = () =>
			app.request(`${lib("user:alice")}/file?path=once.txt`, {
				method: "DELETE",
				headers: { host: "localhost:8080", cookie: alice, "content-type": "application/json" },
				body: "{}",
			});
		const [first, second] = await Promise.all([remove(), remove()]);
		expect([first.status, second.status].sort()).toEqual([200, 404]);
		const usage = await db
			.selectFrom("libraries")
			.select(["used_files", "used_bytes"])
			.where("owner_kind", "=", "user")
			.where("owner_id", "=", aliceId)
			.executeTakeFirstOrThrow();
		expect(usage).toEqual({ used_files: 0, used_bytes: 0 });
	});

	it("lets only one of two concurrent uploads take the last file slot", async () => {
		expect(
			(await call(app, `${lib("user:alice")}/limits`, { method: "PATCH", cookie: admin, body: { files: 1 } })).status,
		).toBe(200);
		const [first, second] = await Promise.all([
			upload(alice, "user:alice", "one.txt", Buffer.from("1")),
			upload(alice, "user:alice", "two.txt", Buffer.from("2")),
		]);
		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([201, 400]);
		expect((await list(alice, "user:alice")).files).toHaveLength(1);
	});

	it("refuses a group deletion while its library has files and deletes the empty library row", async () => {
		const created = await call(app, "/api/user-groups", { cookie: admin, body: { name: "team" } });
		expect(created.status).toBe(201);
		const group = ((await created.json()) as { group: { id: string; name: string } }).group;
		expect(
			(
				await call(app, `${lib("group:team")}/limits`, {
					method: "PATCH",
					cookie: admin,
					body: { files: 2, fileBytes: 16, totalBytes: 16 },
				})
			).status,
		).toBe(200);
		expect((await upload(admin, "group:team", "shared.txt", Buffer.from("shared"))).status).toBe(201);

		const refused = await call(app, `/api/user-groups/${group.id}`, { method: "DELETE", cookie: admin, body: {} });
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ error: expect.stringContaining("1 file") });

		const remove = await app.request(`${lib("group:team")}/file?path=shared.txt`, {
			method: "DELETE",
			headers: { host: "localhost:8080", cookie: admin, "content-type": "application/json" },
			body: "{}",
		});
		expect(remove.status).toBe(200);
		expect(
			(await call(app, `/api/user-groups/${group.id}`, { method: "DELETE", cookie: admin, body: {} })).status,
		).toBe(200);
		expect(await db.selectFrom("libraries").select("id").where("owner_kind", "=", "group").execute()).toEqual([]);
	});

	it("refuses a group deletion racing a committed upload and keeps the file", async () => {
		const created = await call(app, "/api/user-groups", { cookie: admin, body: { name: "racers" } });
		expect(created.status).toBe(201);
		const group = ((await created.json()) as { group: { id: string; name: string } }).group;
		expect(
			(
				await call(app, `${lib("group:racers")}/limits`, {
					method: "PATCH",
					cookie: admin,
					body: { files: 2, fileBytes: 16, totalBytes: 16 },
				})
			).status,
		).toBe(200);
		const record = await findLibraryByRef(db, "group:racers");
		if (!record) throw new Error("the group has no library");
		const upload = beginLibraryUpload(db, backend, {
			library: record.row,
			path: "race.txt",
			overwrite: false,
			createdBy: adminId,
		});
		const data = Buffer.from("race me");
		await upload.write(data);
		await upload.finish();

		// Hold the library row so the deletion request is in flight while the upload has not committed.
		// The upload's commit is queued first, and the deletion then runs against the committed file
		// instead of deleting the library out from under it.
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holding = db.transaction().execute(async (trx) => {
			await trx
				.updateTable("libraries")
				.set({ used_bytes: sql<number>`used_bytes` })
				.where("id", "=", record.row.id)
				.execute();
			await held;
		});
		const committing = upload.commit();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const deleting = call(app, `/api/user-groups/${group.id}`, { method: "DELETE", cookie: admin, body: {} });
		release();
		await holding;
		await committing;

		const refused = await deleting;
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ error: expect.stringContaining("1 file") });
		const row = await db
			.selectFrom("library_files")
			.select(["path", "object_key", "size"])
			.where("library_id", "=", record.row.id)
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({ path: "race.txt", size: data.length });
		expect(await getBytes(backend, row.object_key)).toEqual(data);
		expect(
			await db
				.selectFrom("libraries")
				.select(["used_files", "used_bytes"])
				.where("id", "=", record.row.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ used_files: 1, used_bytes: data.length });
		expect(await db.selectFrom("user_groups").select("id").where("id", "=", group.id).executeTakeFirst()).toBeDefined();
	});

	it("gives group members read and write access", async () => {
		const created = await call(app, "/api/user-groups", { cookie: admin, body: { name: "team" } });
		const group = ((await created.json()) as { group: { id: string } }).group;
		await call(app, `/api/user-groups/${group.id}/members/${aliceId}`, { method: "PUT", cookie: admin, body: {} });
		expect(
			(
				await call(app, `${lib("group:team")}/limits`, {
					method: "PATCH",
					cookie: admin,
					body: { files: 1, fileBytes: 8, totalBytes: 8 },
				})
			).status,
		).toBe(200);
		expect((await upload(alice, "group:team", "member.txt", Buffer.from("ok"))).status).toBe(201);
		expect((await upload(bob, "group:team", "other.txt", Buffer.from("no"))).status).toBe(404);
	});

	it("copies the System settings defaults when a user is created", async () => {
		const defaults = defaultSystemSettings();
		defaults.auth.captcha = "none";
		const settings = SettingsStore.fromSystemSettings(defaults);
		await settings.patch(db, { library: { user: { files: 7, fileBytes: 11, totalBytes: 13 } } }, adminId);
		const withSettings = makeApp(db, undefined, {
			libraryBackend: createLibraryBackend({ backend: "local" }, root),
			settings,
		});
		const adminCookie = await login(withSettings, "root", "root-password");
		const created = await call(withSettings, "/api/users", {
			cookie: adminCookie,
			body: { username: "carol", kind: "member", password: "carol-password" },
		});
		expect(created.status).toBe(201);
		const carol = ((await created.json()) as { user: { id: string } }).user;
		const library = await db
			.selectFrom("libraries")
			.selectAll()
			.where("owner_id", "=", carol.id)
			.executeTakeFirstOrThrow();
		expect(library).toMatchObject({ max_files: 7, max_file_bytes: 11, max_total_bytes: 13 });
	});

	it("sweeps unreferenced objects older than an hour", async () => {
		const backend = createLibraryBackend({ backend: "local" }, root);
		const record = await findLibraryByRef(db, "user:alice");
		if (!record) throw new Error("no alice library");
		const upload = beginLibraryUpload(db, backend, {
			library: record.row,
			path: "kept.txt",
			overwrite: false,
			createdBy: aliceId,
		});
		await upload.write(Buffer.from("kept"));
		await upload.commit();
		const keptKey = (
			await db
				.selectFrom("library_files")
				.select("object_key")
				.where("library_id", "=", record.row.id)
				.executeTakeFirstOrThrow()
		).object_key;

		const oldOrphan = "0".repeat(32);
		const youngOrphan = "1".repeat(32);
		await putBytes(backend, oldOrphan, Buffer.from("old"));
		await putBytes(backend, youngOrphan, Buffer.from("young"));
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(join(root, oldOrphan.slice(0, 2), oldOrphan), twoHoursAgo, twoHoursAgo);

		expect(await sweepLibraryOrphans(db, backend)).toBe(1);
		expect(await getBytes(backend, keptKey)).toEqual(Buffer.from("kept"));
		await expect(getBytes(backend, oldOrphan)).rejects.toThrow();
		expect(await getBytes(backend, youngOrphan)).toEqual(Buffer.from("young"));
	});
});

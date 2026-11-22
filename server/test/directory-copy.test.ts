import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@crh/noise";
import { RemoteError, type TaskStart } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { createLibraryBackend, getBytes, type LibraryBackend } from "../src/library/backend.ts";
import { beginLibraryUpload, deleteLibraryFile, listLibraryDirectory, moveLibraryFile } from "../src/library/files.ts";
import { findUserLibrary } from "../src/library/library.ts";
import { parseFrontmatter, skillCatalog, skillHead, skillsPromptSection } from "../src/library/skills.ts";
import { createRootRuleSet } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { TOOLS, type ToolContext } from "../src/tools/catalog.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { readLinePage } from "../src/util/line-page.ts";
import { ReadAnchors } from "../src/util/read-anchors.ts";
import { handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

const HELLO = { tasks: [], taskKinds: ["file.push", "file.pull"], privilegedMode: "" };

const sha256 = (data: Buffer): Uint8Array => Uint8Array.from(createHash("sha256").update(data).digest());

function tool(name: string) {
	const found = TOOLS.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`${name} is missing`);
	return found;
}

/** Streams `data` from `start` in chunks of `size`, as a backend or SFTP read would. */
function chunked(data: Buffer, size: number): (start: number) => AsyncIterable<Uint8Array> {
	return async function* (start: number) {
		for (let pos = start; pos < data.length; pos += size) yield data.subarray(pos, Math.min(pos + size, data.length));
	};
}

async function page(data: Buffer, startLine: number, lineCount: number, from?: { line: number; byte: number }) {
	const out: Buffer[] = [];
	const read = await readLinePage(chunked(data, 7), (bytes) => out.push(Buffer.from(bytes)), {
		startLine,
		lineCount,
		size: data.length,
		...(from ? { from } : {}),
	});
	return { ...read, text: Buffer.concat(out).toString() };
}

describe("line pages", () => {
	const file = Buffer.from(Array.from({ length: 50 }, (_, i) => `line ${i + 1}${"x".repeat(i % 5)}\n`).join(""));

	it("starts at an anchor with the same page and anchors as a scan from the start", async () => {
		const first = await page(file, 1, 10);
		expect(first.result).toMatchObject({ from: 1, to: 10, eof: false });
		const next = first.anchors.find((anchor) => anchor.line === 11);
		expect(next).toBeDefined();
		for (const startLine of [11, 17, 40]) {
			const scanned = await page(file, startLine, 10);
			const anchored = await page(file, startLine, 10, next);
			expect(anchored.text).toBe(scanned.text);
			expect(anchored.result).toEqual(scanned.result);
			expect(anchored.anchors).toEqual(scanned.anchors);
		}
	});

	it("reports the end and the total, with or without a last newline", async () => {
		expect((await page(file, 45, 10)).result).toEqual({ from: 45, to: 50, eof: true, total: 50, tooLong: false });
		expect((await page(file, 41, 10)).result).toEqual({ from: 41, to: 50, eof: true, total: 50, tooLong: false });
		const open = Buffer.from("a\nb\nc");
		expect((await page(open, 3, 5)).result).toEqual({ from: 3, to: 3, eof: true, total: 3, tooLong: false });
		expect((await page(open, 4, 5)).result).toEqual({ from: 0, to: 0, eof: true, total: 3, tooLong: false });
		expect((await page(Buffer.alloc(0), 1, 5)).result).toEqual({ from: 0, to: 0, eof: true, total: 0, tooLong: false });
	});

	it("keeps whole lines within the byte cap", async () => {
		const out: Buffer[] = [];
		const read = await readLinePage(chunked(file, 5), (bytes) => out.push(Buffer.from(bytes)), {
			startLine: 1,
			lineCount: 50,
			size: file.length,
			maxBytes: 20,
		});
		expect(read.result).toMatchObject({ from: 1, to: 2, eof: false, tooLong: false });
		expect(Buffer.concat(out).toString()).toBe("line 1\nline 2x\n");
	});

	it("says when the first line of the page is longer than the byte cap", async () => {
		const long = Buffer.from(`short\n${"y".repeat(100)}\nafter\n`);
		const out: Buffer[] = [];
		const read = await readLinePage(chunked(long, 9), (bytes) => out.push(Buffer.from(bytes)), {
			startLine: 2,
			lineCount: 3,
			size: long.length,
			maxBytes: 50,
		});
		expect(read.result).toMatchObject({ tooLong: true });
		expect(Buffer.concat(out).length).toBe(0);
	});

	it("keeps the best anchor of a file's version and forgets another version's", () => {
		const anchors = new ReadAnchors();
		anchors.add("f", "v1", [
			{ line: 11, byte: 100 },
			{ line: 21, byte: 200 },
		]);
		expect(anchors.best("f", "v1", 25)).toEqual({ line: 21, byte: 200 });
		expect(anchors.best("f", "v1", 15)).toEqual({ line: 11, byte: 100 });
		expect(anchors.best("f", "v1", 5)).toBeUndefined();
		expect(anchors.best("f", "v2", 25)).toBeUndefined();
		expect(anchors.best("f", "v1", 25)).toBeUndefined();
	});
});

describe("skill frontmatter", () => {
	it("reads plain, quoted and block scalars", () => {
		const values = parseFrontmatter(
			[
				"---",
				"name: deploy-app",
				'description: "Deploys the app: build, push, restart"',
				"single: 'it''s'",
				"folded: >",
				"  first line",
				"  second line",
				"literal: |",
				"  a",
				"  b",
				"metadata:",
				"  nested: ignored",
				"plain: one",
				"  two",
				"---",
				"# Body",
			].join("\n"),
		);
		expect(values?.get("name")).toBe("deploy-app");
		expect(values?.get("description")).toBe("Deploys the app: build, push, restart");
		expect(values?.get("single")).toBe("it's");
		expect(values?.get("folded")).toBe("first line second line");
		expect(values?.get("literal")).toBe("a\nb");
		expect(values?.has("metadata")).toBe(false);
		expect(values?.get("plain")).toBe("one two");
	});

	it("refuses a file without frontmatter, a bad name or no description", () => {
		expect(skillHead("# no frontmatter")).toHaveProperty("invalid");
		expect(skillHead("---\nname: Deploy_App\ndescription: x\n---\n")).toHaveProperty("invalid");
		expect(skillHead("---\nname: deploy\n---\n")).toHaveProperty("invalid");
		expect(skillHead("---\nname: deploy\ndescription: Ship it\n---\n")).toEqual({
			name: "deploy",
			description: "Ship it",
		});
	});
});

describe("library directories, reads and skills", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let backend: LibraryBackend;
	let ownerUserId = "";
	let transferRoot = "";
	let libraryRoot = "";
	let context: ToolContext;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		transferRoot = await mkdtemp(join(tmpdir(), "crhs-transfer-"));
		libraryRoot = await mkdtemp(join(tmpdir(), "crhs-library-"));
		backend = createLibraryBackend({ backend: "local" }, libraryRoot);
		cluster = new Cluster(db, {
			transferRoot,
			libraryBackend: backend,
			reconnectGraceMs: 100,
			dataIdleTimeoutMs: 2000,
		});
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerUserId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
		const tokenId = newId();
		await db
			.insertInto("api_tokens")
			.values({
				id: tokenId,
				org_id: await defaultOrgId(db),
				user_id: ownerUserId,
				name: "t",
				token_hash: newId(),
				created_at: new Date().toISOString(),
				expires_at: null,
				revoked_at: null,
				last_used_at: null,
			})
			.execute();
		const ref = { type: "api_token" as const, id: tokenId };
		await createRootRuleSet(db, await defaultOrgId(db), ref, "yolo", []);
		context = {
			db,
			cluster,
			taskGroups: new TaskGroups(db, cluster),
			user: { sessionId: "s", userId: ownerUserId, username: "owner", kind: "member" as const },
			actor: { type: "api_token", id: tokenId, onBehalfOfUserId: ownerUserId },
			chain: [ref],
			approvalUrl: () => "http://crh.test/approval",
			callRunner: new CallRunner(),
		} as ToolContext;
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
		await rm(transferRoot, { recursive: true, force: true });
		await rm(libraryRoot, { recursive: true, force: true });
	});

	const upload = async (path: string, content: string | Buffer): Promise<void> => {
		const library = await findUserLibrary(db, ownerUserId);
		if (!library) throw new Error("no library");
		const write = beginLibraryUpload(db, backend, { library: library.row, path, overwrite: true, createdBy: null });
		await write.write(Buffer.from(content));
		await write.commit();
	};

	const files = async (path: string): Promise<Record<string, string>> => {
		const library = await findUserLibrary(db, ownerUserId);
		if (!library) throw new Error("no library");
		const out: Record<string, string> = {};
		for (const row of await listLibraryDirectory(db, library.row.id, path)) {
			out[row.path] = (await getBytes(backend, row.object_key)).toString();
		}
		return out;
	};

	const copy = (args: Record<string, unknown>) => tool("copy_file").handler(args as never, context);

	it("copies a library directory file by file, and replaces it with overwrite", async () => {
		await upload("src/SKILL.md", "skill v1");
		await upload("src/scripts/run.sh", "echo v1");
		await upload("dest/old.txt", "stale");
		const refused = copy({
			source: { library: "user:owner", path: "src" },
			destination: { library: "user:owner", path: "dest" },
			recursive: true,
		});
		await expect(refused).rejects.toThrow(/directory already exists at dest/);

		const result = await copy({
			source: { library: "user:owner", path: "src" },
			destination: { library: "user:owner", path: "dest" },
			recursive: true,
			overwrite: true,
		});
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ path: "dest", files: 2 });
		expect(await files("dest")).toEqual({ "dest/SKILL.md": "skill v1", "dest/scripts/run.sh": "echo v1" });
		const library = await findUserLibrary(db, ownerUserId);
		expect(library?.row.used_files).toBe(4);
	});

	it("refuses directory copies to nodes, to the user and past the limits, with the packing advice", async () => {
		await upload("src/a.txt", "a");
		await upload("src/b.txt", "b");
		const source = { library: "user:owner", path: "src" };
		await expect(copy({ source, destination: { targets: ["web-1"], path: "/x" }, recursive: true })).rejects.toThrow(
			/library only.*archive/,
		);
		await expect(copy({ source, destination: { user_interface: true }, recursive: true })).rejects.toThrow(
			/cannot be offered.*archive/,
		);
		context.directoryCopyLimits = { files: 1, bytes: 1024 };
		await expect(
			copy({ source, destination: { library: "user:owner", path: "dest" }, recursive: true }),
		).rejects.toThrow(/at most 1 files.*archive/);
		expect(await files("dest")).toEqual({});
	});

	it("walks a node directory with file.list and pulls each regular file into the library", async () => {
		const key = generateKeyPair();
		const nodeId = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id: nodeId,
				org_id: await defaultOrgId(db),
				name: "web-1",
				name_key: "web-1",
				transport: "client",
				status: "active",
				public_key: Buffer.from(key.publicKey).toString("base64"),
				hostname: "web-1",
				facts: null,
				client_version: null,
				privileged_mode: null,
				last_seen_at: null,
				created_at: now,
				approved_at: now,
				approved_by_user_id: null,
				ssh_host: null,
				ssh_port: null,
				ssh_user: null,
				ssh_host_fingerprint: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		await db
			.insertInto("node_access_grants")
			.values({
				id: newId(),
				org_id: await defaultOrgId(db),
				grantee_type: "user",
				grantee_id: ownerUserId,
				target_type: "node",
				target_id: nodeId,
				created_by_user_id: ownerUserId,
				created_at: now,
			})
			.execute();
		const crha = await agents.connect(key, handshakeInit());
		await crha.peer.request("hello", HELLO);
		await waitFor("link ready", () => cluster.isConnected(nodeId));

		const tree: Record<string, { name: string; type: string; size: number }[]> = {
			"/opt/skill": [
				{ name: "SKILL.md", type: "file", size: 8 },
				{ name: "scripts", type: "dir", size: 0 },
				{ name: "link", type: "symlink", size: 0 },
			],
			"/opt/skill/scripts": [{ name: "run.sh", type: "file", size: 7 }],
		};
		const contents: Record<string, Buffer> = {
			"/opt/skill/SKILL.md": Buffer.from("skill v2"),
			"/opt/skill/scripts/run.sh": Buffer.from("echo v2"),
		};
		const pulled: string[] = [];
		const failing = new Set<string>();
		crha.answerStart = (start: TaskStart) => {
			if (start.spec.kind === "file.pull" && failing.has(start.spec.path)) {
				throw new RemoteError("not_found", `${start.spec.path} is gone`);
			}
			setImmediate(async () => {
				if (start.spec.kind === "file.list") {
					const entries = (tree[start.spec.path] ?? []).map((entry) => ({ ...entry, mode: "0644", mtime: now }));
					crha.exit(
						start.taskId,
						{ kind: "code", value: 0 },
						{
							result: { kind: "file.list", entries, truncated: false },
						},
					);
				} else if (start.spec.kind === "file.pull") {
					const content = contents[start.spec.path] as Buffer;
					pulled.push(start.spec.path);
					const data = await agents.connectData(key, start.taskId, start.spec.endpoint.transferId);
					data.send({ kind: "data", bytes: content });
					data.send({ kind: "end" });
					crha.exit(
						start.taskId,
						{ kind: "code", value: 0 },
						{
							result: { kind: "file.pull", size: content.length, sha256: sha256(content) },
						},
					);
				}
			});
		};

		const result = await copy({
			source: { node: "web-1", path: "/opt/skill" },
			destination: { library: "user:owner", path: "skills/deploy" },
			recursive: true,
		});
		expect(result.isError).toBe(false);
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			library: "user:owner",
			path: "skills/deploy",
			files: 2,
			bytes: 15,
			skipped: ["/opt/skill/link"],
		});
		expect(pulled).toEqual(["/opt/skill/SKILL.md", "/opt/skill/scripts/run.sh"]);
		expect(await files("skills/deploy")).toEqual({
			"skills/deploy/SKILL.md": "skill v2",
			"skills/deploy/scripts/run.sh": "echo v2",
		});

		// Not atomic: a file that fails stops the copy, keeps what was copied and says the directory is incomplete.
		failing.add("/opt/skill/scripts/run.sh");
		const partial = await copy({
			source: { node: "web-1", path: "/opt/skill" },
			destination: { library: "user:owner", path: "skills/deploy" },
			recursive: true,
			overwrite: true,
		});
		expect(partial.isError).toBe(true);
		const body = JSON.parse(partial.content[0]?.text ?? "{}") as {
			error: { code: string; message: string };
			copied: string[];
		};
		expect(body.error.code).toBe("not_found");
		expect(body.error.message).toMatch(/incomplete: 1 of 2 files were copied and the old directory was removed/);
		expect(body.copied).toEqual(["skills/deploy/SKILL.md"]);
		expect(await files("skills/deploy")).toEqual({ "skills/deploy/SKILL.md": "skill v2" });

		// A node file name that is no library path refuses the copy before the old directory is touched.
		failing.clear();
		tree["/opt/skill/scripts"]?.push({ name: "bad\x07name", type: "file", size: 1 });
		pulled.length = 0;
		await expect(
			copy({
				source: { node: "web-1", path: "/opt/skill" },
				destination: { library: "user:owner", path: "skills/deploy" },
				recursive: true,
				overwrite: true,
			}),
		).rejects.toThrow(/scripts\/bad.name cannot be a library file: .*control characters/);
		expect(pulled).toEqual([]);
		expect(await files("skills/deploy")).toEqual({ "skills/deploy/SKILL.md": "skill v2" });
	});

	it("refuses a copy onto a directory that holds the source", async () => {
		await upload("skills/foo/SKILL.md", "foo");
		await upload("skills/bar/SKILL.md", "bar");
		await expect(
			copy({
				source: { library: "user:owner", path: "skills/foo" },
				destination: { library: "user:owner", path: "skills" },
				recursive: true,
				overwrite: true,
			}),
		).rejects.toThrow(/onto a directory that holds it/);
		await expect(
			copy({
				source: { library: "user:owner", path: "skills" },
				destination: { library: "user:owner", path: "skills/foo/x" },
				recursive: true,
			}),
		).rejects.toThrow(/into itself/);
		expect(await files("skills")).toEqual({ "skills/bar/SKILL.md": "bar", "skills/foo/SKILL.md": "foo" });
	});

	it("refuses an overwrite past the library's limits before removing anything", async () => {
		await upload("src/a.txt", "a");
		await upload("src/b.txt", "b");
		await upload("dest/old.txt", "old");
		const library = await findUserLibrary(db, ownerUserId);
		await db
			.updateTable("libraries")
			.set({ max_files: 3 })
			.where("id", "=", library?.row.id ?? "")
			.execute();
		await expect(
			copy({
				source: { library: "user:owner", path: "src" },
				destination: { library: "user:owner", path: "dest" },
				recursive: true,
				overwrite: true,
			}),
		).rejects.toThrow(/would hold 4 files/);
		expect(await files("dest")).toEqual({ "dest/old.txt": "old" });
	});

	it("pages a library file with read_file and starts deeper pages at an anchor", async () => {
		const text = Array.from({ length: 30 }, (_, i) => `row ${i + 1}\n`).join("");
		await upload("notes/log.txt", text);
		const read = (args: Record<string, unknown>) =>
			tool("read_file").handler({ library: "user:owner", path: "notes/log.txt", ...args } as never, context);
		const first = await read({ limit: 10 });
		expect(first.content.map((block) => block.text)).toEqual([
			text.split("\n").slice(0, 10).join("\n").concat("\n"),
			"[user:owner:notes/log.txt, lines 1-10. Use offset=11 to continue.]",
		]);
		const library = await findUserLibrary(db, ownerUserId);
		const row = await db
			.selectFrom("library_files")
			.selectAll()
			.where("library_id", "=", library?.row.id ?? "")
			.where("path", "=", "notes/log.txt")
			.executeTakeFirstOrThrow();
		expect(cluster.readAnchors.best(`library:${row.sha256}`, row.sha256, 11)).toEqual({ line: 11, byte: 61 });
		const last = await read({ offset: 25 });
		expect(last.content[1]?.text).toBe("[user:owner:notes/log.txt, lines 25-30 of 30 (end of file)]");
		expect(last.content[0]?.text).toBe(text.split("\n").slice(24, 30).join("\n").concat("\n"));
		const past = await read({ offset: 40 });
		expect(past.isError).toBe(true);
		expect(past.content[0]?.text).toMatch(/offset_out_of_range/);
	});

	it("lists the owner's skills in the prompt, and none past the limit", async () => {
		await upload("skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Ship the app\n---\nSteps");
		await upload("skills/backup/SKILL.md", '---\nname: backup\ndescription: "Back up: the database"\n---\n');
		await upload("skills/wrong/SKILL.md", "---\nname: other\ndescription: misplaced\n---\n");
		await upload("skills/deploy/scripts/SKILL.md", "---\nname: scripts\ndescription: too deep\n---\n");
		const catalog = await skillCatalog(db, ownerUserId, 64);
		expect(catalog).toEqual({
			kind: "skills",
			skills: [
				{ name: "backup", description: "Back up: the database", path: "skills/backup/SKILL.md" },
				{ name: "deploy", description: "Ship the app", path: "skills/deploy/SKILL.md" },
			],
		});
		const prompt = skillsPromptSection(catalog, "user:owner");
		expect(prompt).toContain('- backup: "Back up: the database"');
		expect(prompt).toContain("path skills/<name>/SKILL.md");

		const tooMany = await skillCatalog(db, ownerUserId, 2);
		expect(tooMany).toEqual({ kind: "too_many", count: 3, limit: 2 });
		expect(skillsPromptSection(tooMany, "user:owner")).toMatch(/more than 2 skills.*list_dir/);
		expect(skillsPromptSection(await skillCatalog(db, newId(), 64), "user:x")).toBe("");
	});

	it("keeps the skill rows with every library write", async () => {
		await upload("skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Ship the app\n---\n");
		await upload("skills/backup/SKILL.md", "---\nname: backup\ndescription: Back up\n---\n");
		const library = await findUserLibrary(db, ownerUserId);
		const libraryId = library?.row.id ?? "";
		const names = async () =>
			(await skillCatalog(db, ownerUserId, 64)).kind === "skills"
				? ((await skillCatalog(db, ownerUserId, 64)) as { skills: { name: string }[] }).skills.map((s) => s.name)
				: [];
		expect(await names()).toEqual(["backup", "deploy"]);

		// A move to another directory keeps the row, now invalid: the name no longer matches.
		await moveLibraryFile(db, backend, libraryId, "skills/backup/SKILL.md", "skills/restore/SKILL.md", false);
		expect(
			await db
				.selectFrom("library_skills")
				.select("invalid")
				.where("path", "=", "skills/restore/SKILL.md")
				.executeTakeFirst(),
		).toEqual({ invalid: "name backup differs from the directory restore" });
		await deleteLibraryFile(db, backend, libraryId, "skills/deploy/SKILL.md");
		expect(await names()).toEqual([]);

		// A copy into the library is a write like any other: the row follows the bytes it wrote.
		await copy({
			source: { library: "user:owner", path: "skills/restore/SKILL.md" },
			destination: { library: "user:owner", path: "skills/backup/SKILL.md" },
		});
		expect(await names()).toEqual(["backup"]);
		expect(
			(await db.selectFrom("library_skills").select(["path", "invalid"]).orderBy("path").execute()).map(
				(row) => `${row.path}: ${row.invalid ?? "valid"}`,
			),
		).toEqual([
			"skills/backup/SKILL.md: valid",
			"skills/restore/SKILL.md: name backup differs from the directory restore",
		]);
	});
});

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, type KeyPair } from "@crh/noise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { createLibraryBackend, type LibraryBackend, newObjectKey, putBytes } from "../src/library/backend.ts";
import { beginLibraryUpload, deleteLibraryFile, findLibraryFile, moveLibraryFile } from "../src/library/files.ts";
import { findLibraryByRef, type LibraryRecord } from "../src/library/library.ts";
import { sweepLibraryOrphans } from "../src/library/sweep.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

// A real WebDAV server may be slow to answer a PROPFIND or a PUT.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const liveUrl = process.env.CRH_TEST_WEBDAV_URL;
const HELLO = { tasks: [], taskKinds: ["file.push", "file.pull"], privilegedMode: "" };
const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * The WebDAV backend against a real server (doc/design/testing/server.md): the collection named by
 * CRH_TEST_WEBDAV_URL is emptied by the test and empty shard collections are left in place.
 */
describe.skipIf(liveUrl === undefined)("WebDAV library backend (live)", () => {
	let db: Db;
	let backend: LibraryBackend;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let transferRoot: string;
	let userId = "";
	let libraryId = "";

	const record = async (): Promise<LibraryRecord> => {
		const found = await findLibraryByRef(db, "user:owner");
		if (!found) throw new Error("no owner library");
		return found;
	};

	const upload = async (path: string, data: Buffer, overwrite = false): Promise<void> => {
		const library = await record();
		const target = beginLibraryUpload(db, backend, {
			library: library.row,
			path,
			overwrite,
			createdBy: userId,
		});
		await target.write(data);
		const { file } = await target.commit();
		expect(file.path).toBe(path);
	};

	const read = async (path: string): Promise<Buffer> => {
		const row = await findLibraryFile(db, libraryId, path);
		if (!row) throw new Error(`no row for ${path}`);
		return readAll(backend.get(row.object_key));
	};

	const emptyCollection = async (): Promise<void> => {
		for await (const object of backend.list()) await backend.delete(object.key);
	};

	beforeAll(async () => {
		const url = new URL(liveUrl as string);
		const username = decodeURIComponent(url.username);
		const password = decodeURIComponent(url.password);
		url.username = "";
		url.password = "";
		backend = createLibraryBackend(
			{ backend: "webdav", url: url.toString(), username, password },
			join(tmpdir(), "unused"),
		);
		db = await openTestDb("sqlite");
		userId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
		libraryId = (await record()).row.id;
		transferRoot = await mkdtemp(join(tmpdir(), "crhs-webdav-transfer-"));
		cluster = new Cluster(db, { transferRoot, libraryBackend: backend });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		await emptyCollection();
	});

	afterAll(async () => {
		await emptyCollection();
		await cluster.close();
		await agents.close();
		await db.destroy();
		await rm(transferRoot, { recursive: true, force: true });
	});

	it("stores, downloads, overwrites, moves and deletes", async () => {
		await upload("docs/a.txt", Buffer.from("first"));
		const first = await findLibraryFile(db, libraryId, "docs/a.txt");
		if (!first) throw new Error("no first row");

		await upload("docs/a.txt", Buffer.from("second"), true);
		expect(await read("docs/a.txt")).toEqual(Buffer.from("second"));
		await expect(readAll(backend.get(first.object_key))).rejects.toThrow();

		const moved = await moveLibraryFile(db, backend, libraryId, "docs/a.txt", "docs/b.txt", false);
		expect(moved.path).toBe("docs/b.txt");
		expect(await read("docs/b.txt")).toEqual(Buffer.from("second"));

		await deleteLibraryFile(db, backend, libraryId, "docs/b.txt");
		await expect(read("docs/b.txt")).rejects.toThrow();
	});

	it("refuses an upload past the one-file limit", async () => {
		await db.updateTable("libraries").set({ max_file_bytes: 4 }).where("id", "=", libraryId).execute();
		const library = await record();
		const target = beginLibraryUpload(db, backend, {
			library: library.row,
			path: "too-big.bin",
			overwrite: false,
			createdBy: userId,
		});
		try {
			await expect(target.write(Buffer.alloc(5))).rejects.toThrow("one-file size limit");
		} finally {
			await target.discard();
			await db
				.updateTable("libraries")
				.set({ max_file_bytes: 32 * 1024 * 1024 })
				.where("id", "=", libraryId)
				.execute();
		}
	});

	it("sweeps an orphaned object listed through the shard collections", async () => {
		const kept = Buffer.from("kept");
		await upload("kept.txt", kept);
		const keptRow = await findLibraryFile(db, libraryId, "kept.txt");
		if (!keptRow) throw new Error("no kept row");

		const orphan = newObjectKey();
		await putBytes(backend, orphan, Buffer.from("orphan"));
		expect(await sweepLibraryOrphans(db, backend, Date.now() + 1, 0)).toBe(1);
		await expect(readAll(backend.get(orphan))).rejects.toThrow();
		expect(await readAll(backend.get(keptRow.object_key))).toEqual(kept);
	});

	it("pushes a library file to a node and pulls a node file into the library", async () => {
		const { node, key } = await addNode();
		const crha = await connect(node, key);
		const content = Buffer.from("library file for the node");
		await upload("docs/push.txt", content);
		const push = await cluster.pushLibraryFile({
			nodeId: node.id,
			path: "/srv/push.txt",
			libraryId,
			libraryPath: "docs/push.txt",
			actor: { type: "user", id: userId, onBehalfOfUserId: userId },
		});
		await waitFor("push task.start", () => crha.starts.length === 1);
		const pushStart = crha.starts[0];
		if (pushStart?.spec.kind !== "file.push") throw new Error("no push spec");
		const pushData = await agents.connectData(key, push.id, pushStart.spec.endpoint.transferId);
		expect(await collect(pushData)).toEqual(content);
		crha.exit(push.id);
		await waitFor("push task exited", async () => (await cluster.getTask(push.id))?.state === "exited");

		const pulled = Buffer.from("pulled into the library");
		const pull = await cluster.pullLibraryFile({
			nodeId: node.id,
			path: "/etc/app.conf",
			libraryId,
			libraryPath: "in/from-node.txt",
			createdBy: userId,
			actor: { type: "user", id: userId, onBehalfOfUserId: userId },
		});
		await waitFor("pull task.start", () => crha.starts.length === 2);
		const pullStart = crha.starts[1];
		if (pullStart?.spec.kind !== "file.pull") throw new Error("no pull spec");
		const pullData = await agents.connectData(key, pull.id, pullStart.spec.endpoint.transferId);
		pullData.send({ kind: "data", bytes: pulled });
		pullData.send({ kind: "end" });
		crha.exit(
			pull.id,
			{ kind: "code", value: 0 },
			{
				result: {
					kind: "file.pull",
					size: pulled.length,
					sha256: Uint8Array.from(Buffer.from(sha256Hex(pulled), "hex")),
				},
			},
		);
		await waitFor("pull task exited", async () => (await cluster.getTask(pull.id))?.state === "exited");
		const row = await findLibraryFile(db, libraryId, "in/from-node.txt");
		if (!row) throw new Error("no pulled row");
		expect(await readAll(backend.get(row.object_key))).toEqual(pulled);
	});

	const addNode = async (): Promise<{ node: NodeRow; key: KeyPair }> => {
		const key = generateKeyPair();
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
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
				grantee_id: userId,
				target_type: "node",
				target_id: id,
				created_by_user_id: userId,
				created_at: now,
			})
			.execute();
		return { node: await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow(), key };
	};

	const connect = async (node: NodeRow, key: KeyPair): Promise<FakeCrha> => {
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", HELLO)).toEqual({ acks: [] });
		await waitFor("link ready", () => cluster.isConnected(node.id));
		return crha;
	};
});

async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const parts: Buffer[] = [];
	for await (const chunk of chunks) parts.push(Buffer.from(chunk));
	return Buffer.concat(parts);
}

async function collect(data: { next(): Promise<{ kind: string; bytes?: Uint8Array }> }): Promise<Buffer> {
	const parts: Buffer[] = [];
	for (;;) {
		const frame = await data.next();
		if (frame.kind === "data" && frame.bytes) parts.push(Buffer.from(frame.bytes));
		else if (frame.kind === "end") return Buffer.concat(parts);
		else throw new Error(`unexpected data frame ${frame.kind}`);
	}
}

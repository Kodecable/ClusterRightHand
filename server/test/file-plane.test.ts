import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@crh/noise";
import { RemoteError, type TaskSpec } from "@crh/protocol";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cluster, specFromRow } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { createLibraryBackend, getBytes, newObjectKey, putBytes } from "../src/library/backend.ts";
import { createRootRuleSet } from "../src/policy/store.ts";
import { specSha256 } from "../src/privilege/payload.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { TOOLS, type ToolContext } from "../src/tools/catalog.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

const HELLO = { tasks: [], taskKinds: ["file.push", "file.pull"], privilegedMode: "" };
const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

describe("file plane transfers", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let ownerUserId = "";
	let transferRoot = "";
	let libraryRoot = "";
	let libraryBackend: ReturnType<typeof createLibraryBackend>;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		transferRoot = await mkdtemp(join(tmpdir(), "crhs-transfer-"));
		libraryRoot = await mkdtemp(join(tmpdir(), "crhs-library-"));
		libraryBackend = createLibraryBackend({ backend: "local" }, libraryRoot);
		cluster = new Cluster(db, { transferRoot, libraryBackend, reconnectGraceMs: 100 });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerUserId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
		await rm(transferRoot, { recursive: true, force: true });
		await rm(libraryRoot, { recursive: true, force: true });
	});

	const actor = () => ({ type: "user" as const, id: ownerUserId, onBehalfOfUserId: ownerUserId });

	const addNode = async (name: string): Promise<{ node: NodeRow; key: ReturnType<typeof generateKeyPair> }> => {
		const key = generateKeyPair();
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name.toLowerCase(),
				transport: "client",
				status: "active",
				public_key: Buffer.from(key.publicKey).toString("base64"),
				hostname: name,
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
				target_id: id,
				created_by_user_id: ownerUserId,
				created_at: now,
			})
			.execute();
		return { node: await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow(), key };
	};

	const connect = async (node: NodeRow, key: ReturnType<typeof generateKeyPair>): Promise<FakeCrha> => {
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", HELLO)).toEqual({ acks: [] });
		await waitFor("link ready", () => cluster.isConnected(node.id));
		return crha;
	};

	/** Opens the data connection of a push and reads the bytes up to [end]. */
	const collectPush = async (
		key: ReturnType<typeof generateKeyPair>,
		start: { taskId: string; spec: TaskSpec },
	): Promise<Buffer> => {
		if (start.spec.kind !== "file.push") throw new Error("no push spec");
		const data = await agents.connectData(key, start.taskId, start.spec.endpoint.transferId);
		const chunks: Buffer[] = [];
		for (;;) {
			const frame = await data.next();
			if (frame.kind === "data") chunks.push(Buffer.from(frame.bytes));
			else if (frame.kind === "end") return Buffer.concat(chunks);
			else throw new Error(`unexpected abort ${frame.code}`);
		}
	};

	it("pushes a staged file to the node over a data connection", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		// More than one data frame holds, so crhs must split it at the protocol's chunk size.
		const source = Buffer.alloc(70 * 1024, 7);
		const location = await cluster.stageBytesForPush(source);
		const task = await cluster.pushFile({ nodeId: node.id, path: "/srv/app.bin", location, actor: actor() });
		expect(task.kind).toBe("file.push");
		await waitFor("push task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		expect(start?.spec.kind).toBe("file.push");
		if (start?.spec.kind !== "file.push") throw new Error("no push spec");
		const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		const chunks: Buffer[] = [];
		for (;;) {
			const frame = await data.next();
			if (frame.kind === "data") chunks.push(Buffer.from(frame.bytes));
			else if (frame.kind === "end") break;
			else throw new Error(`unexpected abort ${frame.code}`);
		}
		expect(Buffer.concat(chunks).equals(source)).toBe(true);
		crha.exit(task.id);
		await waitFor("push task exited", async () => (await cluster.getTask(task.id))?.state === "exited");
		const done = await cluster.getTask(task.id);
		expect(done?.result).toBeNull();
	});

	it("pulls a node file into the staging location and verifies it", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const content = Buffer.from("pulled content");
		const task = await cluster.pullFile({
			nodeId: node.id,
			path: "/etc/app.conf",
			maxBytes: 1024,
			actor: actor(),
		});
		expect(task.kind).toBe("file.pull");
		await waitFor("pull task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (start?.spec.kind !== "file.pull") throw new Error("no pull spec");
		const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		data.send({ kind: "data", bytes: content });
		data.send({ kind: "end" });
		crha.exit(
			task.id,
			{ kind: "code", value: 0 },
			{
				result: {
					kind: "file.pull",
					size: content.length,
					sha256: Uint8Array.from(Buffer.from(sha256Hex(content), "hex")),
				},
			},
		);
		await waitFor("pull task exited", async () => (await cluster.getTask(task.id))?.state === "exited");
		const row = await db.selectFrom("tasks").select("transfer").where("id", "=", task.id).executeTakeFirstOrThrow();
		const record = JSON.parse(row.transfer ?? "null") as { location: { path: string } };
		const received = await readFile(join(transferRoot, record.location.path));
		expect(received.equals(content)).toBe(true);
		const done = await cluster.getTask(task.id);
		expect(done?.result?.kind).toBe("file.pull");
	});

	it("fails a pull whose bytes do not match its result and keeps no file", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const content = Buffer.from("received content");
		const task = await cluster.pullFile({ nodeId: node.id, path: "/etc/app.conf", maxBytes: 1024, actor: actor() });
		await waitFor("pull task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (start?.spec.kind !== "file.pull") throw new Error("no pull spec");
		const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		data.send({ kind: "data", bytes: content });
		data.send({ kind: "end" });
		crha.exit(
			task.id,
			{ kind: "code", value: 0 },
			{
				result: {
					kind: "file.pull",
					size: content.length,
					sha256: Uint8Array.from(Buffer.alloc(32, 0x7f)),
				},
			},
		);
		await waitFor("pull task failed", async () => (await cluster.getTask(task.id))?.state === "failed");
		const done = await cluster.getTask(task.id);
		expect(done?.errorCode).toBe("input_mismatch");
		const row = await db.selectFrom("tasks").select("transfer").where("id", "=", task.id).executeTakeFirstOrThrow();
		const record = JSON.parse(row.transfer ?? "null") as { location: { path: string } };
		await expect(readFile(join(transferRoot, record.location.path))).rejects.toThrow();
	});

	it("fails a pull as soon as the node sends more than max_bytes", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const task = await cluster.pullFile({ nodeId: node.id, path: "/etc/app.conf", maxBytes: 4, actor: actor() });
		await waitFor("pull task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (start?.spec.kind !== "file.pull") throw new Error("no pull spec");
		const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		data.send({ kind: "data", bytes: Buffer.from("12345") });
		await waitFor("pull task failed", async () => (await cluster.getTask(task.id))?.state === "failed");
		const done = await cluster.getTask(task.id);
		expect(done?.errorCode).toBe("too_large");
		expect(await readdir(transferRoot)).toEqual([]);
	});

	it("discards a finished pull's staged bytes when the task ends unknown without task.exit", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const content = Buffer.from("received bytes");
		const task = await cluster.pullFile({ nodeId: node.id, path: "/etc/app.conf", maxBytes: 1024, actor: actor() });
		await waitFor("pull task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (start?.spec.kind !== "file.pull") throw new Error("no pull spec");
		const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		data.send({ kind: "data", bytes: content });
		data.send({ kind: "end" });
		// [end] arrived (crhs closes the data connection); the task.exit that would commit never does.
		await data.closed;
		crha.ws.close();
		await waitFor("pull task unknown", async () => (await cluster.getTask(task.id))?.state === "unknown");
		await waitFor("staged bytes discarded", async () => (await readdir(transferRoot)).length === 0);
	});

	it("retries a transfer start the node refuses with busy", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		let refusals = 2;
		crha.answerStart = () => {
			if (refusals > 0) {
				refusals -= 1;
				throw new RemoteError("busy", "the node is already running a transfer");
			}
		};
		const location = await cluster.stageBytesForPush(Buffer.from("retried"));
		const task = await cluster.pushFile({ nodeId: node.id, path: "/srv/retried.bin", location, actor: actor() });
		// The refusal means nothing ran, so the same start is sent again until the node accepts it.
		await waitFor("push task.start retried", () => crha.starts.length === 3);
		await waitFor("push task running", async () => (await cluster.getTask(task.id))?.state === "running");
	});

	it("refuses a data connection for an unknown transfer id", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const location = await cluster.stageBytesForPush(Buffer.from("x"));
		const task = await cluster.pushFile({ nodeId: node.id, path: "/x", location, actor: actor() });
		await waitFor("push task.start", () => crha.starts.length === 1);
		const data = await agents.connectData(key, task.id, "not-the-transfer");
		const closed = await data.closed;
		expect(closed.code).toBe(1008);
		expect(crha.starts.length).toBe(1);
	});

	const addLibraryFile = async (path: string, data: Buffer): Promise<string> => {
		const library = await db
			.selectFrom("libraries")
			.select("id")
			.where("owner_kind", "=", "user")
			.where("owner_id", "=", ownerUserId)
			.executeTakeFirstOrThrow();
		const objectKey = newObjectKey();
		const stored = await putBytes(libraryBackend, objectKey, data);
		const now = new Date().toISOString();
		await db
			.insertInto("library_files")
			.values({
				library_id: library.id,
				path,
				size: stored.size,
				sha256: stored.sha256,
				media_type: "application/octet-stream",
				backend: "local",
				object_key: objectKey,
				created_by: ownerUserId,
				created_at: now,
				updated_at: now,
			})
			.execute();
		await db
			.updateTable("libraries")
			.set({
				used_files: sql<number>`used_files + 1`,
				used_bytes: sql<number>`used_bytes + ${stored.size}`,
			})
			.where("id", "=", library.id)
			.execute();
		return library.id;
	};

	it("accepts a transfer id for one data connection while its task lives", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const task = await cluster.pullFile({ nodeId: node.id, path: "/etc/app.conf", maxBytes: 1024, actor: actor() });
		await waitFor("pull task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (start?.spec.kind !== "file.pull") throw new Error("no pull spec");
		const first = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		const second = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		expect((await second.closed).code).toBe(1008);
		// The first connection still owns the id; aborting it fails the task.
		first.send({ kind: "abort", code: "cancelled" });
		await waitFor("pull task failed", async () => (await cluster.getTask(task.id))?.state === "failed");
	});

	it("pushes a library file to a node", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const content = Buffer.from("library file content");
		const libraryId = await addLibraryFile("docs/app.bin", content);
		const task = await cluster.pushLibraryFile({
			nodeId: node.id,
			path: "/srv/app.bin",
			libraryId,
			libraryPath: "docs/app.bin",
			actor: actor(),
		});
		await waitFor("push task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (start?.spec.kind !== "file.push") throw new Error("no push spec");
		expect(start.spec.size).toBe(content.length);
		const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		const chunks: Buffer[] = [];
		for (;;) {
			const frame = await data.next();
			if (frame.kind === "data") chunks.push(Buffer.from(frame.bytes));
			else if (frame.kind === "end") break;
			else throw new Error(`unexpected abort ${frame.code}`);
		}
		expect(Buffer.concat(chunks).equals(content)).toBe(true);
		crha.exit(task.id);
		await waitFor("push task exited", async () => (await cluster.getTask(task.id))?.state === "exited");
	});

	it("pulls a node file into a library path", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const content = Buffer.from("pulled into the library");
		await addLibraryFile("existing.txt", Buffer.from("old"));
		const library = await db
			.selectFrom("libraries")
			.select("id")
			.where("owner_id", "=", ownerUserId)
			.executeTakeFirstOrThrow();
		const task = await cluster.pullLibraryFile({
			nodeId: node.id,
			path: "/etc/app.conf",
			libraryId: library.id,
			libraryPath: "in/from-node.txt",
			createdBy: ownerUserId,
			actor: actor(),
		});
		await waitFor("pull task.start", () => crha.starts.length === 1);
		const start = crha.starts[0];
		if (start?.spec.kind !== "file.pull") throw new Error("no pull spec");
		const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
		data.send({ kind: "data", bytes: content });
		data.send({ kind: "end" });
		crha.exit(
			task.id,
			{ kind: "code", value: 0 },
			{
				result: {
					kind: "file.pull",
					size: content.length,
					sha256: Uint8Array.from(Buffer.from(sha256Hex(content), "hex")),
				},
			},
		);
		await waitFor("pull task exited", async () => (await cluster.getTask(task.id))?.state === "exited");
		const row = await db
			.selectFrom("library_files")
			.selectAll()
			.where("library_id", "=", library.id)
			.where("path", "=", "in/from-node.txt")
			.executeTakeFirstOrThrow();
		expect(row.size).toBe(content.length);
		expect(await getBytes(libraryBackend, row.object_key)).toEqual(content);
		const after = await db
			.selectFrom("libraries")
			.select(["used_files", "used_bytes"])
			.where("id", "=", library.id)
			.executeTakeFirstOrThrow();
		expect(after).toEqual({ used_files: 2, used_bytes: 3 + content.length });
	});

	it("refuses a pull onto a directory or under a file", async () => {
		const { node, key } = await addNode("web-1");
		const crha = await connect(node, key);
		const content = Buffer.from("x");
		const libraryId = await addLibraryFile("blocked/child.txt", Buffer.from("child"));
		await addLibraryFile("plain.txt", Buffer.from("plain"));
		let starts = 0;
		const pull = async (libraryPath: string): Promise<string> => {
			const task = await cluster.pullLibraryFile({
				nodeId: node.id,
				path: "/etc/app.conf",
				libraryId,
				libraryPath,
				createdBy: ownerUserId,
				actor: actor(),
			});
			starts += 1;
			await waitFor("pull task.start", () => crha.starts.length === starts);
			const start = crha.starts[starts - 1];
			if (start?.spec.kind !== "file.pull") throw new Error("no pull spec");
			const data = await agents.connectData(key, task.id, start.spec.endpoint.transferId);
			data.send({ kind: "data", bytes: content });
			data.send({ kind: "end" });
			crha.exit(
				task.id,
				{ kind: "code", value: 0 },
				{
					result: {
						kind: "file.pull",
						size: content.length,
						sha256: Uint8Array.from(Buffer.from(sha256Hex(content), "hex")),
					},
				},
			);
			await waitFor("pull task failed", async () => (await cluster.getTask(task.id))?.state === "failed");
			return (await cluster.getTask(task.id))?.errorMessage ?? "";
		};

		expect(await pull("blocked")).toContain("a directory already exists at blocked");
		expect(await pull("plain.txt/child.txt")).toContain("a file already exists at plain.txt");
	});

	it("copies a library file to several nodes as one approved task group with a transfer per member", async () => {
		const web1 = await addNode("web-1");
		const web2 = await addNode("web-2");
		const crha1 = await connect(web1.node, web1.key);
		const crha2 = await connect(web2.node, web2.key);
		const content = Buffer.from("one library object, two transfers\n");
		await addLibraryFile("docs/shared.bin", content);

		const tokenId = newId();
		await db
			.insertInto("api_tokens")
			.values({
				id: tokenId,
				org_id: await defaultOrgId(db),
				user_id: ownerUserId,
				name: "copy chain",
				token_hash: newId(),
				created_at: new Date().toISOString(),
				expires_at: null,
				revoked_at: null,
				last_used_at: null,
			})
			.execute();
		const ref = { type: "api_token" as const, id: tokenId };
		await createRootRuleSet(db, await defaultOrgId(db), ref, "yolo", [
			{ action: "require-approval", method: "file.write", nodes: [web1.node.id] },
		]);

		const taskGroups = new TaskGroups(db, cluster);
		const user = { sessionId: "s", userId: ownerUserId, username: "owner", kind: "member" as const };
		const context = {
			db,
			cluster,
			taskGroups,
			user,
			actor: actor(),
			chain: [ref],
			approvalUrl: () => "http://crh.test/approval",
		} as ToolContext;
		const tool = TOOLS.find((candidate) => candidate.name === "copy_file");
		if (!tool) throw new Error("copy_file is missing");
		const pending = tool.handler(
			{
				source: { library: "user:owner", path: "docs/shared.bin" },
				targets: ["web-1", "web-2"],
				path: "/srv/shared.bin",
			} as never,
			context,
		);

		const waiting = await waitFor("group waiting for approval", async () => {
			const row = await db.selectFrom("task_groups").selectAll().executeTakeFirst();
			return row?.state === "awaiting_approval" ? row : undefined;
		});
		// The copy is one group, not one independent task per node, so there is one approval to give.
		expect(await db.selectFrom("task_groups").select("id").execute()).toHaveLength(1);
		expect((await taskGroups.get(waiting.id))?.tasks).toEqual([]);
		await taskGroups.decide(waiting.id, {
			decision: "approved",
			by: actor(),
			at: new Date().toISOString(),
			taskGroupId: waiting.id,
		});

		await waitFor("both pushes start", () => crha1.starts.length === 1 && crha2.starts.length === 1);
		const start1 = crha1.starts[0] as NonNullable<(typeof crha1.starts)[number]>;
		const start2 = crha2.starts[0] as NonNullable<(typeof crha2.starts)[number]>;
		const [bytes1, bytes2] = await Promise.all([collectPush(web1.key, start1), collectPush(web2.key, start2)]);
		expect(bytes1.equals(content)).toBe(true);
		expect(bytes2.equals(content)).toBe(true);
		crha1.exit(start1.taskId);
		crha2.exit(start2.taskId);

		const result = await pending;
		expect(result.isError).toBe(false);
		const body = JSON.parse(result.content[0]?.text ?? "{}") as { state: string; nodes: unknown[] };
		expect(body.state).toBe("finished");
		expect(body.nodes).toHaveLength(2);

		const tasks = await db.selectFrom("tasks").selectAll().execute();
		expect(tasks).toHaveLength(2);
		const records = tasks.map(
			(row) => JSON.parse(row.transfer ?? "null") as { transferId: string; location: { kind: string; path: string } },
		);
		expect(new Set(records.map((record) => record.transferId)).size).toBe(2);
		expect(records.map((record) => `${record.location.kind}:${record.location.path}`)).toEqual([
			"library:docs/shared.bin",
			"library:docs/shared.bin",
		]);
		// The endpoint differs per member, but the hash approval and authorization bind is the group's.
		const hashes = new Set(tasks.map((row) => Buffer.from(specSha256(specFromRow(row.spec, "task"))).toString("hex")));
		const groupHash = Buffer.from(specSha256(specFromRow(waiting.spec, "task group"))).toString("hex");
		expect(hashes).toEqual(new Set([groupHash]));
		const finished = await taskGroups.get(waiting.id);
		expect(finished?.approval?.decision).toMatchObject({ decision: "approved" });
	});

	it("deletes a node-to-nodes staging file when the task group ends", async () => {
		const web1 = await addNode("web-1");
		const web2 = await addNode("web-2");
		const crha1 = await connect(web1.node, web1.key);
		const crha2 = await connect(web2.node, web2.key);
		const content = Buffer.from("staged once, pushed twice\n");
		const location = await cluster.stageBytesForPush(content);
		const spec: TaskSpec = {
			kind: "file.push",
			path: "/tmp/copied.bin",
			size: content.length,
			sha256: Uint8Array.from(Buffer.from(sha256Hex(content), "hex")),
			overwrite: false,
			mode: 0,
			owner: "",
			group: "",
			endpoint: { kind: "crhs", transferId: "" },
		};
		const taskGroups = new TaskGroups(db, cluster);
		const id = await taskGroups.create({
			targets: [web1.node.name, web2.node.name],
			nodeIds: [web1.node.id, web2.node.id],
			spec,
			transferLocation: location,
			actor: actor(),
		});
		await waitFor("both pushes start", () => crha1.starts.length === 1 && crha2.starts.length === 1);
		const start1 = crha1.starts[0] as NonNullable<(typeof crha1.starts)[number]>;
		const start2 = crha2.starts[0] as NonNullable<(typeof crha2.starts)[number]>;
		await Promise.all([collectPush(web1.key, start1), collectPush(web2.key, start2)]);
		crha1.exit(start1.taskId);
		crha2.exit(start2.taskId);
		expect((await taskGroups.wait(id, 5000))?.state).toBe("finished");
		await expect(readFile(join(transferRoot, location.path))).rejects.toThrow();
	});
});

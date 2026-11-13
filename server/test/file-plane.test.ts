import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@crh/noise";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
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

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		transferRoot = await mkdtemp(join(tmpdir(), "crhs-transfer-"));
		cluster = new Cluster(db, { transferRoot });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerUserId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
		await rm(transferRoot, { recursive: true, force: true });
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
});

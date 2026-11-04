import { createHash } from "node:crypto";
import { generateKeyPair } from "@crh/noise";
import {
	encode as encodeCbor,
	type Facts,
	factsToJson,
	handshakeInitCodec,
	MAX_FRAME_BYTES,
	OPTIONAL_NAMES,
	PROTOCOL_MAJOR,
	PROTOCOL_MINOR,
	REQUIRED_NAMES,
	RemoteError,
	SUPPORTED_NAMES,
	type TaskStart,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
import { negotiateCommands } from "../src/cluster/agent-server.ts";
import { BATCH_GROUP_BYTES, BATCH_NODE_BYTES } from "../src/cluster/batch-output.ts";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

const FACTS: Facts = {
	hostname: "node-1",
	osId: "ubuntu",
	osVersionId: "24.04",
	osPrettyName: "Ubuntu 24.04 LTS",
	kernel: "6.8.0",
	arch: "x86_64",
	initSystem: "systemd",
	packageManagers: ["apt"],
	privilegeTools: ["sudo"],
	notesPath: "/etc/crh-notes.md",
	groups: ["sudo"],
	clockOffsetMs: 12,
	shells: { sh: "/bin/sh", bash: "/usr/bin/bash" },
};

const HELLO = { tasks: [], taskKinds: [], privilegedMode: "" };
const EXEC = {
	kind: "exec" as const,
	command: { argv: ["cat"] },
	env: {},
	cwd: "",
	stdin: null,
};

/**
 * Wraps `db` so the next node lookup resolves `entered`, waits for `release`, and only then runs. Kysely
 * returns a new builder from every chained call, so each link is proxied.
 */
function blockNextNodeLookup(db: Db): { db: Db; entered: Promise<void>; release: () => void } {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const wrap = (query: object): object =>
		new Proxy(query, {
			get(target, property) {
				const value = Reflect.get(target, property, target) as unknown;
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (property === "executeTakeFirst") {
						entered.resolve();
						return released.promise.then(() => Reflect.apply(value, target, args));
					}
					const result = Reflect.apply(value, target, args) as unknown;
					return result !== null && typeof result === "object" ? wrap(result) : result;
				};
			},
		});
	const gated = new Proxy(db, {
		get(target, property) {
			if (property === "selectFrom") return (table: string) => wrap(target.selectFrom(table as never));
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Db;
	return { db: gated, entered: entered.promise, release: () => released.resolve() };
}

describe("agent wire protocol", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let owner: SessionUser;
	let app: App;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db, { reconnectGraceMs: 600_000 });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		owner = { sessionId: "s", userId: user.id, username: user.username, kind: "member" };
		app = makeApp(db, undefined, { cluster });
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	const addNode = async (name: string, status: "active" | "pending", publicKey: Uint8Array): Promise<NodeRow> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				owner_user_id: owner.userId,
				name,
				name_key: name.toLowerCase(),
				transport: "client",
				status,
				public_key: Buffer.from(publicKey).toString("base64"),
				hostname: name,
				facts: null,
				client_version: null,
				privileged_mode: null,
				last_seen_at: null,
				created_at: now,
				approved_at: status === "active" ? now : null,
				approved_by_user_id: null,
				ssh_host: null,
				ssh_port: null,
				ssh_user: null,
				ssh_host_key: null,
				ssh_credential_id: null,
				ssh_jumps: null,
			})
			.execute();
		return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	};

	const createExec = (nodeId: string, input?: Uint8Array) =>
		cluster.createTask({
			nodeId,
			spec: EXEC,
			...(input ? { input } : {}),
			actor: { type: "system", id: "test", onBehalfOfUserId: owner.userId },
		});

	const connectActive = async (name = "active-1", key = generateKeyPair()) => {
		const node = await addNode(name, "active", key.publicKey);
		const crha = await agents.connect(key, handshakeInit());
		expect(await crha.peer.request("hello", HELLO)).toEqual({ acks: [] });
		await waitFor("link ready", () => cluster.isConnected(node.id));
		return { node, key, crha };
	};

	const connectPending = async (name = "pending-1") => {
		const key = generateKeyPair();
		const node = await addNode(name, "pending", key.publicKey);
		const crha = await agents.connect(key, handshakeInit());
		expect(crha.response.nodeState).toBe("pending");
		expect(await crha.peer.request("hello", HELLO)).toEqual({ acks: [] });
		return { node, crha };
	};

	describe("handshake", () => {
		it("rejects a different protocol major with 1008", async () => {
			const { ws, hs, closed } = await agents.prepare(generateKeyPair());
			ws.send(
				hs.writeMessage(encodeCbor(handshakeInitCodec.encode(handshakeInit({ protocolMajor: PROTOCOL_MAJOR + 1 })))),
			);
			await expect(closed).resolves.toEqual({
				code: 1008,
				reason: `protocol_major mismatch: server ${PROTOCOL_MAJOR}, client ${PROTOCOL_MAJOR + 1}`,
			});
		});

		it("rejects a major-1 peer at the Noise handshake", async () => {
			// The prologue carries the major version, so the old peer fails before its payload is read.
			const { ws, hs, closed } = await agents.prepare(generateKeyPair(), "crh/1");
			ws.send(hs.writeMessage(encodeCbor(handshakeInitCodec.encode(handshakeInit()))));
			await expect(closed).resolves.toEqual({ code: 1008, reason: "handshake failed" });
		});

		it("accepts a different protocol minor", async () => {
			// The minor is additive: a peer that knows more optional names still connects.
			const key = generateKeyPair();
			const node = await addNode("minor-1", "active", key.publicKey);
			const crha = await agents.connect(key, handshakeInit({ protocolMinor: PROTOCOL_MINOR + 1 }));
			expect(await crha.peer.request("hello", HELLO)).toEqual({ acks: [] });
			await waitFor("different-minor link ready", () => cluster.isConnected(node.id));
		});

		it("rejects a missing required command with 1008", async () => {
			const { ws, hs, closed } = await agents.prepare(generateKeyPair());
			const commands = SUPPORTED_NAMES.filter((name) => name !== "task.query");
			ws.send(hs.writeMessage(encodeCbor(handshakeInitCodec.encode(handshakeInit({ commands })))));
			await expect(closed).resolves.toEqual({ code: 1008, reason: "missing required command: task.query" });
		});

		it("accepts a peer that offers only the required names", async () => {
			const key = generateKeyPair();
			const node = await addNode("legacy-1", "active", key.publicKey);
			const crha = await agents.connect(key, handshakeInit({ commands: [...REQUIRED_NAMES] }), REQUIRED_NAMES);
			expect(crha.response).toMatchObject({ protocolMinor: PROTOCOL_MINOR, commands: [...SUPPORTED_NAMES] });
			expect(await crha.peer.request("hello", HELLO)).toEqual({ acks: [] });
			await waitFor("legacy link ready", () => cluster.isConnected(node.id));
			expect(await crha.peer.request("ping", { seq: 3 })).toEqual({ seq: 3 });
		});

		it("negotiates only the 1.1 names both sides offer", () => {
			expect(negotiateCommands(REQUIRED_NAMES)).toEqual({
				missing: undefined,
				negotiated: [...REQUIRED_NAMES],
				optional: [],
			});
			expect(negotiateCommands(SUPPORTED_NAMES)).toEqual({
				missing: undefined,
				negotiated: [...SUPPORTED_NAMES],
				optional: [...OPTIONAL_NAMES],
			});
			expect(negotiateCommands([...REQUIRED_NAMES.filter((n) => n !== "hello"), ...OPTIONAL_NAMES])).toEqual({
				missing: "hello",
				negotiated: SUPPORTED_NAMES.filter((name) => name !== "hello"),
				optional: [...OPTIONAL_NAMES],
			});
		});

		it("does not attach a connection that closed during the handshake", async () => {
			const key = generateKeyPair();
			const { node, crha: first } = await connectActive("closed-during-handshake", key);
			const gated = blockNextNodeLookup(db);
			const second = await TestAgentServer.start(gated.db, agents.identity, cluster);
			try {
				const { ws, hs, closed } = await second.prepare(key);
				ws.send(hs.writeMessage(encodeCbor(handshakeInitCodec.encode(handshakeInit()))));
				// Hold the server inside findNodeByPublicKey, close the socket, then let it continue.
				await gated.entered;
				ws.close();
				await closed;
				gated.release();
				await new Promise((resolve) => setTimeout(resolve, 0));
				// The dead socket must not replace the node's live connection.
				expect(cluster.isConnected(node.id)).toBe(true);
				expect(await first.peer.request("ping", { seq: 5 })).toEqual({ seq: 5 });
			} finally {
				gated.release();
				await second.close();
			}
		});
	});

	describe("protocol errors", () => {
		it("disconnects on an unknown non-ASCII event name and keeps serving", async () => {
			const { node, crha } = await connectActive();
			crha.sendRaw(encodeCbor([2, "事件".repeat(30), []]));
			const closed = await crha.closed;
			expect(closed.code).toBe(1000);
			expect(closed.reason.startsWith("protocol error: ")).toBe(true);
			expect(Buffer.byteLength(closed.reason, "utf8")).toBeLessThanOrEqual(123);
			await waitFor("first link detached", () => !cluster.isConnected(node.id));

			// The server process survived the close: a new link still handshakes and serves requests.
			const key = generateKeyPair();
			const secondNode = await addNode("active-2", "active", key.publicKey);
			const second = await agents.connect(key, handshakeInit());
			expect(await second.peer.request("hello", HELLO)).toEqual({ acks: [] });
			await waitFor("second link ready", () => cluster.isConnected(secondNode.id));
			expect(await second.peer.request("ping", { seq: 9 })).toEqual({ seq: 9 });
		});

		it("bounds a close reason that embeds peer-controlled non-ASCII text", async () => {
			const { crha } = await connectActive();
			crha.sendRaw(encodeCbor([2, "task.output", ["t-1", "事件".repeat(30), 0, new Uint8Array(0)]]));
			const closed = await crha.closed;
			expect(closed.code).toBe(1000);
			expect(Buffer.byteLength(closed.reason, "utf8")).toBeLessThanOrEqual(123);
			expect(closed.reason.startsWith("protocol error: invalid task.output event body:")).toBe(true);
		});
	});

	it("answers ping and performs the active handshake", async () => {
		const { node, crha } = await connectActive();
		expect(crha.response).toMatchObject({
			protocolMajor: PROTOCOL_MAJOR,
			protocolMinor: PROTOCOL_MINOR,
			nodeState: "active",
			nodeId: node.id,
			commands: [...SUPPORTED_NAMES],
		});
		expect(await crha.peer.request("ping", { seq: 7 })).toEqual({ seq: 7 });
	});

	it("records facts events from an active node", async () => {
		const { node, crha } = await connectActive();
		crha.peer.emit("facts", FACTS);
		const row = await waitFor("facts stored", async () => {
			const r = await db.selectFrom("nodes").select("facts").where("id", "=", node.id).executeTakeFirst();
			return r?.facts ? r : undefined;
		});
		expect(JSON.parse(row.facts as string)).toEqual(factsToJson(FACTS));
	});

	it("accepts a facts event with only the required keys", async () => {
		const { node, crha } = await connectActive();
		const minimal: Facts = { hostname: "node-1", groups: ["sudo"] };
		crha.peer.emit("facts", minimal);
		const row = await waitFor("minimal facts stored", async () => {
			const r = await db.selectFrom("nodes").select("facts").where("id", "=", node.id).executeTakeFirst();
			return r?.facts ? r : undefined;
		});
		// Absent optional facts stay absent instead of being stored as nulls.
		expect(JSON.parse(row.facts as string)).toEqual({ hostname: "node-1", groups: ["sudo"] });
	});

	it("sends the input only after task.start is accepted, then records the exit", async () => {
		const { node, crha } = await connectActive();
		const starts: TaskStart[] = [];
		const inputs: { taskId: string; offset: number; data: Uint8Array }[] = [];
		let accept!: () => void;
		const accepted = new Promise<void>((resolve) => {
			accept = resolve;
		});
		crha.peer.onRequest("task.start", async (start) => {
			starts.push(start);
			await accepted;
			return {};
		});
		crha.peer.onRequest("task.input", (input) => {
			inputs.push(input);
			return {};
		});
		crha.peer.onRequest("task.cancel", () => ({}));
		const acks: { taskId: string }[] = [];
		crha.peer.onEvent("task.exit.ack", (ack) => {
			acks.push(ack);
		});

		const created = await createExec(node.id, Buffer.from("hello"));
		await waitFor("task.start", () => starts.length === 1);
		expect(starts[0]).toMatchObject({
			taskId: created.id,
			attempt: 1,
			spec: { ...EXEC, stdin: { size: 5 } },
			privileged: false,
			authorizations: [],
			timeoutMs: 0,
			killGraceMs: 0,
			output: { kind: "full", spillBytes: 50 * 1024, spillLines: 2000 },
		});
		const startSpec = starts[0]?.spec;
		if (startSpec?.kind !== "exec") throw new Error("expected an exec spec");
		expect(Buffer.from(startSpec.stdin?.sha256 as Uint8Array).toString("hex")).toBe(
			createHash("sha256").update("hello").digest("hex"),
		);
		// Nothing may be sent before the success response.
		expect(inputs).toEqual([]);

		accept();
		await waitFor("task.input", () => inputs.length === 1);
		expect(inputs[0]?.taskId).toBe(created.id);
		expect(inputs[0]?.offset).toBe(0);
		expect(Buffer.from(inputs[0]?.data as Uint8Array).toString()).toBe("hello");
		await waitFor("running", async () => (await cluster.getTask(created.id))?.state === "running");

		crha.peer.emit("task.output", {
			taskId: created.id,
			stream: "stdout",
			offset: 0,
			data: Buffer.from("out"),
		});
		crha.peer.emit("task.exit", {
			taskId: created.id,
			outcome: { kind: "code", value: 0 },
			timedOut: false,
			cancelled: false,
			stdoutEnd: 3,
			stderrEnd: 0,
			outputFile: "",
			result: null,
		});
		const view = await waitFor("exited", async () => {
			const t = await cluster.getTask(created.id);
			return t?.state === "exited" ? t : undefined;
		});
		expect(view.exitCode).toBe(0);
		expect(view.stdoutHead).toBe("out");
		await waitFor("exit ack", () => acks.length === 1);
		expect(acks[0]).toEqual({ taskId: created.id });
	});

	it("records a status task from task.exit alone, without any task.output", async () => {
		const { node, crha } = await connectActive();
		const starts: TaskStart[] = [];
		crha.peer.onRequest("task.start", (start) => {
			starts.push(start);
			return {};
		});
		crha.peer.onEvent("task.exit.ack", () => {});
		const created = await cluster.createTask({
			nodeId: node.id,
			spec: EXEC,
			outputMode: "status",
			actor: { type: "system", id: "test", onBehalfOfUserId: owner.userId },
		});
		await waitFor("task.start", () => starts.length === 1);
		expect(starts[0]?.output).toEqual({ kind: "status" });

		crha.peer.emit("task.exit", {
			taskId: created.id,
			outcome: { kind: "code", value: 0 },
			timedOut: false,
			cancelled: false,
			stdoutEnd: 1234,
			stderrEnd: 56,
			outputFile: "/var/lib/crha/output/t.log",
			result: null,
		});
		const view = await waitFor("exited", async () => {
			const t = await cluster.getTask(created.id);
			return t?.state === "exited" ? t : undefined;
		});
		expect(view).toMatchObject({
			outputMode: "status",
			exitCode: 0,
			stdoutBytes: 1234,
			stderrBytes: 56,
			stdoutHead: "",
			stdoutTail: "",
			stderrHead: "",
			stderrTail: "",
			outputFile: "/var/lib/crha/output/t.log",
			result: null,
		});
	});

	it("shares one text output budget across a task group", async () => {
		const peers: Awaited<ReturnType<typeof connectActive>>[] = [];
		for (let i = 0; i < 8; i++) peers.push(await connectActive(`text-${i}`));
		const starts = new Map<string, string>();
		for (const peer of peers) {
			peer.crha.peer.onEvent("task.exit.ack", () => {});
			peer.crha.peer.onRequest("task.start", (start: TaskStart) => {
				starts.set(start.taskId, peer.node.id);
				return {};
			});
		}
		const groups = new TaskGroups(db, cluster);
		const groupId = await groups.create({
			targets: ["group:text"],
			nodeIds: peers.map((peer) => peer.node.id),
			spec: EXEC,
			actor: { type: "system", id: "test", onBehalfOfUserId: owner.userId },
			parallel: 8,
			outputMode: "text",
		});
		await waitFor("all task starts", () => starts.size === 8);
		const taskIdByNode = new Map([...starts].map(([taskId, nodeId]) => [nodeId, taskId]));
		const data = Buffer.alloc(BATCH_NODE_BYTES + 2 * 1024, 0x61);
		for (const peer of peers) {
			const taskId = taskIdByNode.get(peer.node.id) as string;
			peer.crha.peer.emit("task.output", { taskId, stream: "stdout", offset: 0, data });
			peer.crha.peer.emit("task.exit", {
				taskId,
				outcome: { kind: "code", value: 0 },
				timedOut: false,
				cancelled: false,
				stdoutEnd: data.length,
				stderrEnd: 0,
				outputFile: "/tmp/text.log",
				result: null,
			});
		}
		const view = await groups.wait(groupId, 10_000);
		if (!view) throw new Error("group missing");
		expect(view.state).toBe("finished");
		expect(view.outputMode).toBe("text");
		const byNode = new Map(view.tasks.map((t) => [t.nodeId, t]));
		const tails = peers.map((peer) => byNode.get(peer.node.id)?.stdoutTail.length ?? 0);
		// Different sockets arrive in no fixed order, but grants are handed out in arrival order: six nodes
		// get 8 KiB, the next the remaining 2 KiB of the group budget, and the last one nothing.
		expect([...tails].sort((a, b) => a - b)).toEqual([0, 2048, 8192, 8192, 8192, 8192, 8192, 8192]);
		expect(tails.reduce((sum, n) => sum + n, 0)).toBe(BATCH_GROUP_BYTES);
		for (const peer of peers) {
			expect(byNode.get(peer.node.id)).toMatchObject({
				outputMode: "text",
				stdoutBytes: data.length,
				stderrBytes: 0,
				stdoutHead: "",
				stderrHead: "",
				stderrTail: "",
				outputFile: "/tmp/text.log",
				result: null,
			});
		}
	});

	it("keeps a text group's budget until the group ends, even with parallel: 1", async () => {
		const peers: Awaited<ReturnType<typeof connectActive>>[] = [];
		for (let i = 0; i < 8; i++) peers.push(await connectActive(`sequential-text-${i}`));
		const pending: { peer: (typeof peers)[number]; taskId: string }[] = [];
		for (const peer of peers) {
			peer.crha.peer.onEvent("task.exit.ack", () => {});
			peer.crha.peer.onRequest("task.start", (start: TaskStart) => {
				pending.push({ peer, taskId: start.taskId });
				return {};
			});
		}
		const groups = new TaskGroups(db, cluster);
		const nodeIds = peers.map((peer) => peer.node.id);
		const groupId = await groups.create({
			targets: ["group:sequential-text"],
			nodeIds,
			spec: EXEC,
			actor: { type: "system", id: "test", onBehalfOfUserId: owner.userId },
			parallel: 1,
			outputMode: "text",
		});
		const data = Buffer.alloc(BATCH_NODE_BYTES, 0x61);
		for (let i = 0; i < peers.length; i++) {
			const next = await waitFor(`task.start ${i + 1}`, () => pending.shift());
			next.peer.crha.peer.emit("task.output", { taskId: next.taskId, stream: "stdout", offset: 0, data });
			next.peer.crha.peer.emit("task.exit", {
				taskId: next.taskId,
				outcome: { kind: "code", value: 0 },
				timedOut: false,
				cancelled: false,
				stdoutEnd: data.length,
				stderrEnd: 0,
				outputFile: "/tmp/text.log",
				result: null,
			});
		}
		const view = await groups.wait(groupId, 10_000);
		if (!view) throw new Error("group missing");
		expect(view.state).toBe("finished");
		const byNode = new Map(view.tasks.map((t) => [t.nodeId, t]));
		const tails = nodeIds.map((nodeId) => byNode.get(nodeId)?.stdoutTail.length ?? -1);
		// A fresh budget per node (the old behaviour) would keep 8 KiB for each of the eight. One budget
		// for the whole group gives six nodes 8 KiB, the seventh the remaining 2 KiB, the eighth nothing.
		expect(tails).toEqual([
			...Array.from({ length: 6 }, () => BATCH_NODE_BYTES),
			BATCH_GROUP_BYTES - 6 * BATCH_NODE_BYTES,
			0,
		]);
		expect(tails.reduce((sum, bytes) => sum + bytes, 0)).toBe(BATCH_GROUP_BYTES);
		// Release happens when the group itself finishes: a repeated release finds no entry.
		expect(cluster.releaseGroupBudget(groupId)).toBe(false);
	});

	it("acks a recorded task from the row after reconnect, without charging the budget again", async () => {
		const peers: Awaited<ReturnType<typeof connectActive>>[] = [];
		for (let i = 0; i < 8; i++) peers.push(await connectActive(`reconnected-text-${i}`));
		const starts = new Map<string, string>();
		for (const peer of peers) {
			peer.crha.peer.onEvent("task.exit.ack", () => {});
			peer.crha.peer.onRequest("task.start", (start: TaskStart) => {
				starts.set(start.taskId, peer.node.id);
				return {};
			});
		}
		const groups = new TaskGroups(db, cluster);
		const groupId = await groups.create({
			targets: ["group:reconnected-text"],
			nodeIds: peers.map((peer) => peer.node.id),
			spec: EXEC,
			actor: { type: "system", id: "test", onBehalfOfUserId: owner.userId },
			parallel: 8,
			outputMode: "text",
		});
		await waitFor("all task starts", () => starts.size === 8);
		const taskIdByNode = new Map([...starts].map(([taskId, nodeId]) => [nodeId, taskId]));
		const data = Buffer.alloc(BATCH_NODE_BYTES, 0x61);
		const first = peers[0] as (typeof peers)[number];
		const firstTaskId = taskIdByNode.get(first.node.id) as string;
		const exit = {
			taskId: firstTaskId,
			outcome: { kind: "code" as const, value: 0 },
			timedOut: false,
			cancelled: false,
			stdoutEnd: data.length,
			stderrEnd: 0,
			outputFile: "/tmp/text.log",
			result: null,
		};
		first.crha.peer.emit("task.output", { taskId: firstTaskId, stream: "stdout", offset: 0, data });
		first.crha.peer.emit("task.exit", exit);
		await waitFor("first task recorded", async () => (await cluster.getTask(firstTaskId))?.state === "exited");

		// Its task.exit.ack was lost: the node reconnects and reports the finished task in hello.
		first.crha.ws.close();
		await first.crha.closed;
		await waitFor("first link detached", () => !cluster.isConnected(first.node.id));
		const reconnected = await agents.connect(first.key, handshakeInit());
		const exitAcks: { taskId: string }[] = [];
		reconnected.peer.onEvent("task.exit.ack", (ack) => {
			exitAcks.push(ack);
		});
		expect(
			await reconnected.peer.request("hello", {
				tasks: [{ taskId: firstTaskId, state: "exited", stdoutEnd: data.length, stderrEnd: 0 }],
				taskKinds: [],
				privilegedMode: "",
			}),
		).toEqual({ acks: [{ taskId: firstTaskId, stdoutOffset: data.length, stderrOffset: 0 }] });
		// It has nothing to resend: sending only task.exit is enough and must not close the connection.
		reconnected.peer.emit("task.exit", exit);
		await waitFor("exit ack after reconnect", () => exitAcks.length === 1);
		expect(exitAcks[0]).toEqual({ taskId: firstTaskId });
		expect(cluster.isConnected(first.node.id)).toBe(true);
		expect(await reconnected.peer.request("ping", { seq: 11 })).toEqual({ seq: 11 });

		for (const peer of peers.slice(1)) {
			const taskId = taskIdByNode.get(peer.node.id) as string;
			peer.crha.peer.emit("task.output", { taskId, stream: "stdout", offset: 0, data });
			peer.crha.peer.emit("task.exit", {
				taskId,
				outcome: { kind: "code", value: 0 },
				timedOut: false,
				cancelled: false,
				stdoutEnd: data.length,
				stderrEnd: 0,
				outputFile: "/tmp/text.log",
				result: null,
			});
		}
		const view = await groups.wait(groupId, 10_000);
		if (!view) throw new Error("group missing");
		expect(view.state).toBe("finished");
		const byNode = new Map(view.tasks.map((t) => [t.nodeId, t]));
		const tails = peers.map((peer) => byNode.get(peer.node.id)?.stdoutTail.length ?? -1);
		// The reconnected node's 8 KiB was granted once and does not draw from the budget again: the other
		// seven nodes share the remaining 43008 bytes, so the group still saves its full 51200 bytes.
		expect([...tails].sort((a, b) => a - b)).toEqual([0, 2048, 8192, 8192, 8192, 8192, 8192, 8192]);
		expect(tails.reduce((sum, bytes) => sum + bytes, 0)).toBe(BATCH_GROUP_BYTES);
	});

	it("records a late result for an unknown task that hello reports again", async () => {
		const key = generateKeyPair();
		const { node, crha: first } = await connectActive("late-result-1", key);
		first.peer.onEvent("task.exit.ack", () => {});
		first.peer.onRequest("task.start", () => ({}));
		const created = await createExec(node.id);
		await waitFor("running", async () => (await cluster.getTask(created.id))?.state === "running");
		const taskId = created.id;

		// The node drops and comes back without the task: crhs asks, and crha answers unknown.
		first.ws.close();
		await first.closed;
		await waitFor("node link detached", () => !cluster.isConnected(node.id));
		const second = await agents.connect(key, handshakeInit());
		second.peer.onEvent("task.exit.ack", () => {});
		second.peer.onRequest("task.query", (query) => ({
			taskId: query.taskId,
			state: "unknown",
			stdoutEnd: 0,
			stderrEnd: 0,
		}));
		expect(await second.peer.request("hello", HELLO)).toEqual({ acks: [] });
		const unknown = await waitFor("unknown", async () => {
			const t = await cluster.getTask(taskId);
			return t?.state === "unknown" ? t : undefined;
		});
		expect(unknown.errorCode).toBe("executor_restarted");

		// It reconnects again, reports the task, resends the output and then the exit.
		second.ws.close();
		await second.closed;
		await waitFor("node link detached again", () => !cluster.isConnected(node.id));
		const third = await agents.connect(key, handshakeInit());
		const acks: { taskId: string }[] = [];
		third.peer.onEvent("task.exit.ack", (ack) => {
			acks.push(ack);
		});
		expect(
			await third.peer.request("hello", {
				tasks: [{ taskId, state: "unknown", stdoutEnd: 0, stderrEnd: 0 }],
				taskKinds: [],
				privilegedMode: "",
			}),
		).toEqual({ acks: [{ taskId, stdoutOffset: 0, stderrOffset: 0 }] });
		third.peer.emit("task.output", { taskId, stream: "stdout", offset: 0, data: Buffer.from("late") });
		third.peer.emit("task.exit", {
			taskId,
			outcome: { kind: "code", value: 0 },
			timedOut: false,
			cancelled: false,
			stdoutEnd: 4,
			stderrEnd: 0,
			outputFile: "",
			result: null,
		});
		const late = await waitFor("late result", async () => {
			const row = await db
				.selectFrom("tasks")
				.select(["state", "late_result"])
				.where("id", "=", taskId)
				.executeTakeFirst();
			return row?.late_result ? row : undefined;
		});
		expect(late.state).toBe("unknown");
		expect(JSON.parse(late.late_result as string)).toMatchObject({
			exit_code: 0,
			stdout_bytes: 4,
			stderr_bytes: 0,
		});
		await waitFor("exit ack", () => acks.length === 1);
		expect(acks[0]).toEqual({ taskId });
		expect(await third.peer.request("ping", { seq: 3 })).toEqual({ seq: 3 });
	});

	it("records a late result for an unknown task whose live record was lost", async () => {
		const { node, crha } = await connectActive("late-result-2");
		const acks: { taskId: string }[] = [];
		crha.peer.onEvent("task.exit.ack", (ack) => {
			acks.push(ack);
		});
		const starts: TaskStart[] = [];
		crha.peer.onRequest("task.start", (start) => {
			starts.push(start);
			return {};
		});
		const created = await createExec(node.id);
		await waitFor("task.start", () => starts.length === 1);

		// A crhs restart keeps the row but loses the in-memory live record. Build that state from the row
		// this task left behind: a second unknown task the server has never held live.
		const source = await db.selectFrom("tasks").selectAll().where("id", "=", created.id).executeTakeFirstOrThrow();
		const taskId = newId();
		await db
			.insertInto("tasks")
			.values({
				...source,
				id: taskId,
				state: "unknown",
				error_code: "connection_lost",
				error_message: "execution status unknown",
				finished_at: new Date().toISOString(),
				late_result: null,
			})
			.execute();

		// Its exit must still record the late result instead of being acked and dropped as already recorded.
		crha.peer.emit("task.exit", {
			taskId,
			outcome: { kind: "code", value: 0 },
			timedOut: false,
			cancelled: false,
			stdoutEnd: 0,
			stderrEnd: 0,
			outputFile: "",
			result: null,
		});
		const late = await waitFor("late result without live", async () => {
			const row = await db
				.selectFrom("tasks")
				.select(["state", "late_result"])
				.where("id", "=", taskId)
				.executeTakeFirst();
			return row?.late_result ? row : undefined;
		});
		expect(late.state).toBe("unknown");
		expect(JSON.parse(late.late_result as string)).toMatchObject({
			exit_code: 0,
			stdout_bytes: 0,
			stderr_bytes: 0,
		});
		await waitFor("exit ack without live", () => acks.length === 1);
		expect(acks[0]).toEqual({ taskId });
		expect(await crha.peer.request("ping", { seq: 9 })).toEqual({ seq: 9 });
	});

	it("batch output defaults to status and rejects other modes through the API", async () => {
		const { node, crha } = await connectActive();
		const starts: TaskStart[] = [];
		crha.peer.onRequest("task.start", (start) => {
			starts.push(start);
			return {};
		});
		const cookie = await login(app, "owner", "password-123");
		const bad = await call(app, "/api/task-groups", {
			cookie,
			body: { kind: "exec", shell: "true", targets: [node.id], outputMode: "full" },
		});
		expect(bad.status).toBe(400);
		const res = await call(app, "/api/task-groups", {
			cookie,
			body: { kind: "exec", shell: "true", targets: [node.id], waitMs: 0 },
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { taskGroup: { outputMode: string } };
		expect(created.taskGroup.outputMode).toBe("status");
		await waitFor("task.start", () => starts.length === 1);
		expect(starts[0]?.output).toEqual({ kind: "status" });
	});

	describe("task.start errors", () => {
		const terminal = async (id: string): Promise<TaskView> =>
			waitFor("task terminal", async () => {
				const t = await cluster.getTask(id);
				return t && (["exited", "failed", "rejected", "unknown", "denied"].includes(t.state) ? t : undefined);
			});

		it.each([
			["authorization_required", "rejected"],
			["authorization_invalid", "rejected"],
			["authorization_expired", "rejected"],
			["authorization_rejected", "rejected"],
			["invalid_spec", "failed"],
			["local_policy_denied", "failed"],
		])("maps %s to %s", async (code, expected) => {
			const { node, crha } = await connectActive();
			crha.peer.onRequest("task.start", () => {
				throw new RemoteError(code, "no");
			});
			const created = await createExec(node.id);
			const view = await terminal(created.id);
			expect(view.state).toBe(expected);
			expect(view.errorCode).toBe(code);
			expect(view.errorMessage).toBe("no");
		});

		it("fails a TaskStart that cannot be encoded as invalid_spec and keeps the link", async () => {
			const { node, crha } = await connectActive();
			const starts: TaskStart[] = [];
			crha.peer.onRequest("task.start", (start) => {
				starts.push(start);
				return {};
			});
			const created = await cluster.createTask({
				nodeId: node.id,
				spec: { ...EXEC, env: { HUGE: "x".repeat(MAX_FRAME_BYTES + 1) } },
				actor: { type: "system", id: "test", onBehalfOfUserId: owner.userId },
			});
			const view = await terminal(created.id);
			expect(view.state).toBe("failed");
			expect(view.errorCode).toBe("invalid_spec");
			expect(view.errorMessage).toMatch(/frame too large/);
			// The request was never put on the wire, and the link is still usable.
			expect(starts).toEqual([]);
			expect(cluster.isConnected(node.id)).toBe(true);
			expect(await crha.peer.request("ping", { seq: 4 })).toEqual({ seq: 4 });
		});

		it("stays dispatched when the connection drops before the response", async () => {
			const { node, crha } = await connectActive();
			const started = Promise.withResolvers<void>();
			crha.peer.onRequest("task.start", () => {
				started.resolve();
				return new Promise(() => {});
			});
			const created = await createExec(node.id, Buffer.from("input"));
			await started.promise;
			crha.ws.close();
			await crha.closed;
			await waitFor("node link detached", () => !cluster.isConnected(node.id));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect((await cluster.getTask(created.id))?.state).toBe("dispatched");
		});

		it("adopts a task hello reports as running after its start response was lost", async () => {
			const key = generateKeyPair();
			const { node, crha: first } = await connectActive("reconnect-1", key);
			const started = Promise.withResolvers<void>();
			first.peer.onRequest("task.start", () => {
				started.resolve();
				return new Promise(() => {});
			});
			const created = await createExec(node.id, Buffer.from("input"));
			await started.promise;
			await waitFor("dispatched", async () => (await cluster.getTask(created.id))?.state === "dispatched");

			first.ws.close();
			await first.closed;
			await waitFor("node link detached", () => !cluster.isConnected(node.id));

			// The client accepted the task before losing the response, so it still runs and reports it.
			const second = await agents.connect(key, handshakeInit());
			second.peer.onEvent("task.exit.ack", () => {});
			const taskId = created.id;
			expect(
				await second.peer.request("hello", {
					tasks: [{ taskId, state: "running", stdoutEnd: 0, stderrEnd: 0 }],
					taskKinds: [],
					privilegedMode: "",
				}),
			).toEqual({ acks: [{ taskId, stdoutOffset: 0, stderrOffset: 0 }] });
			const running = await waitFor("running after hello", async () => {
				const t = await cluster.getTask(taskId);
				return t?.state === "running" ? t : undefined;
			});
			expect(running.finishedAt).toBeNull();
			const accepted = await db.selectFrom("tasks").select("accepted_at").where("id", "=", taskId).executeTakeFirst();
			expect(accepted?.accepted_at).not.toBeNull();

			second.peer.emit("task.output", { taskId, stream: "stdout", offset: 0, data: Buffer.from("late") });
			second.peer.emit("task.exit", {
				taskId,
				outcome: { kind: "code", value: 0 },
				result: null,
				timedOut: false,
				cancelled: false,
				stdoutEnd: 4,
				stderrEnd: 0,
				outputFile: "",
			});
			const view = await waitFor("exited after replay", async () => {
				const t = await cluster.getTask(taskId);
				return t?.state === "exited" ? t : undefined;
			});
			expect(view.exitCode).toBe(0);
			expect(view.stdoutHead).toBe("late");
		});
	});

	describe("restricted connection", () => {
		it("allows ping, facts and hello; everything else is node_pending", async () => {
			const { node, crha } = await connectPending();
			expect(await crha.peer.request("ping", { seq: 1 })).toEqual({ seq: 1 });
			crha.peer.emit("facts", FACTS);
			await waitFor("facts stored", async () => {
				const row = await db.selectFrom("nodes").select("facts").where("id", "=", node.id).executeTakeFirst();
				return row?.facts ? row : undefined;
			});
			await expect(crha.peer.request("task.query", { taskId: "x" })).rejects.toMatchObject({
				name: "RemoteError",
				code: "node_pending",
			});
			await expect(
				crha.peer.request("task.start", {
					taskId: "x",
					attempt: 1,
					spec: EXEC,
					privileged: false,
					authorizations: [],
					timeoutMs: 0,
					killGraceMs: 0,
					output: { kind: "full", spillBytes: 0, spillLines: 0 },
				}),
			).rejects.toMatchObject({ code: "node_pending" });
		});

		it("approving through the API emits node.status active, then closes", async () => {
			const { node, crha } = await connectPending();
			const seen: { state: string; message: string }[] = [];
			const order: string[] = [];
			crha.peer.onEvent("node.status", (status) => {
				seen.push(status);
				order.push("status");
			});
			crha.closed.then(() => order.push("close"));
			const cookie = await login(app, "owner", "password-123");
			const res = await call(app, `/api/nodes/${node.id}/approve`, { cookie, body: {} });
			expect(res.status).toBe(200);
			await crha.closed;
			expect(seen).toEqual([{ nodeId: node.id, state: "active", message: "approved" }]);
			expect(order).toEqual(["status", "close"]);
		});

		it("deleting through the API emits node.status rejected, then closes", async () => {
			const { node, crha } = await connectPending();
			const seen: { state: string; message: string }[] = [];
			const order: string[] = [];
			crha.peer.onEvent("node.status", (status) => {
				seen.push(status);
				order.push("status");
			});
			crha.closed.then(() => order.push("close"));
			const cookie = await login(app, "owner", "password-123");
			const res = await call(app, `/api/nodes/${node.id}`, { method: "DELETE", cookie, body: {} });
			expect(res.status).toBe(200);
			await crha.closed;
			expect(seen).toEqual([{ nodeId: node.id, state: "rejected", message: "node deleted" }]);
			expect(order).toEqual(["status", "close"]);
		});
	});
});

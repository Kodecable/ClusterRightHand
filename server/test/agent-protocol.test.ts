import { createHash } from "node:crypto";
import { generateKeyPair } from "@crh/noise";
import {
	encode as encodeCbor,
	type Facts,
	factsToJson,
	handshakeInitCodec,
	MAX_FRAME_BYTES,
	RemoteError,
	SUPPORTED_NAMES,
	type TaskStart,
} from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "../src/auth/sessions.ts";
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
};

const HELLO = { tasks: [], taskKinds: [], privilegedMode: "" };
const EXEC = {
	kind: "exec" as const,
	command: { argv: ["cat"] },
	env: {},
	cwd: "",
	stdin: null,
};

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
		cluster.close();
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
			ws.send(hs.writeMessage(encodeCbor(handshakeInitCodec.encode(handshakeInit({ protocolMajor: 2 })))));
			await expect(closed).resolves.toEqual({
				code: 1008,
				reason: "protocol_major mismatch: server 1, client 2",
			});
		});

		it("rejects a missing required command with 1008", async () => {
			const { ws, hs, closed } = await agents.prepare(generateKeyPair());
			const commands = SUPPORTED_NAMES.filter((name) => name !== "task.query");
			ws.send(hs.writeMessage(encodeCbor(handshakeInitCodec.encode(handshakeInit({ commands })))));
			await expect(closed).resolves.toEqual({ code: 1008, reason: "missing required command: task.query" });
		});
	});

	it("answers ping and performs the active handshake", async () => {
		const { node, crha } = await connectActive();
		expect(crha.response).toMatchObject({
			protocolMajor: 1,
			protocolMinor: 0,
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
		const created = (await res.json()) as { group: { outputMode: string } };
		expect(created.group.outputMode).toBe("status");
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

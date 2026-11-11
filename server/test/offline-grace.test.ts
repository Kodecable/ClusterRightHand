import { generateKeyPair } from "@crh/noise";
import type { TaskSpec } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

const GRACE_MS = 300;
const HELLO = { tasks: [], taskKinds: [], privilegedMode: "" };
const EXEC: TaskSpec = { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null };

describe("node offline grace", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let ownerUserId = "";

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		cluster = new Cluster(db, { nodeOfflineGraceMs: GRACE_MS });
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		ownerUserId = (await createUser(db, { username: "owner", kind: "member", password: "password-123" })).id;
	});

	afterEach(async () => {
		await cluster.close();
		await agents.close();
		await db.destroy();
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

	it("dispatches a task when the node reconnects within the grace", async () => {
		const { node, key } = await addNode("reconnect");
		const created = cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
		// The task is created while the node is away and waits; then the node comes back.
		await new Promise((resolve) => setTimeout(resolve, 40));
		const crha = await connect(node, key);
		const task = await created;
		expect(task.errorCode).not.toBe("node_offline");
		await waitFor("task.start after the reconnect", () => crha.starts.length === 1);
		expect(crha.starts[0]?.taskId).toBe(task.id);
	});

	it("fails the task with node_offline after the grace", async () => {
		const { node } = await addNode("stays-offline");
		const started = Date.now();
		const task = await cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
		expect(Date.now() - started).toBeGreaterThanOrEqual(GRACE_MS - 20);
		expect(task).toMatchObject({
			state: "failed",
			errorCode: "node_offline",
			errorMessage: "the node is not connected",
		});
	});

	it("fails an SSH node with no route at once, not after the grace", async () => {
		const { node } = await addNode("ssh-no-route");
		await db
			.updateTable("nodes")
			.set({ transport: "ssh", public_key: null, ssh_host: "10.0.0.1", ssh_port: 22, ssh_user: "root" })
			.where("id", "=", node.id)
			.execute();
		// A long grace proves the SSH path does not poll: without a route it can never become ready.
		const slow = new Cluster(db, { nodeOfflineGraceMs: 5_000 });
		try {
			const started = Date.now();
			const task = await slow.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(task).toMatchObject({ state: "failed", errorCode: "node_offline" });
		} finally {
			await slow.close();
		}
	});

	it("runs the online nodes of a task group and fails the offline one with node_offline", async () => {
		const online = await addNode("online");
		const offline = await addNode("offline");
		const crha = await connect(online.node, online.key);
		crha.peer.onEvent("task.exit.ack", () => {});
		const groups = new TaskGroups(db, cluster);
		const groupId = await groups.create({
			targets: [online.node.id, offline.node.id],
			nodeIds: [online.node.id, offline.node.id],
			spec: EXEC,
			actor: actor(),
			parallel: 2,
			outputMode: "status",
		});
		await waitFor("task.start on the online node", () => crha.starts.length === 1);
		const onlineTaskId = crha.starts[0]?.taskId as string;
		crha.peer.emit("task.exit", {
			taskId: onlineTaskId,
			outcome: { kind: "code", value: 0 },
			timedOut: false,
			cancelled: false,
			outputEnd: 0,
			outputFile: "",
			outputLines: 0,
			result: null,
		});
		const view = await groups.wait(groupId, 2_000);
		if (!view) throw new Error("group missing");
		expect(view.state).toBe("finished");
		expect(view.tasks.find((task) => task.nodeId === online.node.id)).toMatchObject({ state: "exited" });
		expect(view.tasks.find((task) => task.nodeId === offline.node.id)).toMatchObject({
			state: "failed",
			errorCode: "node_offline",
		});
	});
});

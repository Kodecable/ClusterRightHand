import { generateKeyPair } from "@crh/noise";
import { type TaskSpec, taskSpecToJson } from "@crh/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import type { NodeRow } from "../src/cluster/nodes.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { openTestDb } from "./helpers/db.ts";

// A loaded machine can push these past the default 5 s timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const EXEC: TaskSpec = {
	kind: "exec",
	command: { argv: ["sleep", "30"] },
	env: {},
	cwd: "",
	stdin: null,
};

/**
 * Startup recovery and the output kept for unknown tasks (doc/execution-plane.md#断线恢复, #输出):
 * a task a previous process left dispatched or running must end instead of staying `running` forever,
 * and the buffer kept for a late result must not outlive the node that could still send one.
 */
describe("cluster recovery", () => {
	let db: Db;
	let cluster: Cluster;
	let agents: TestAgentServer;
	let identity: ServerIdentity;
	let owner: { userId: string };
	/** The extra cluster of a restart test, closed with the suite. */
	let later: Cluster | undefined;
	let laterAgents: TestAgentServer | undefined;

	const GRACE_MS = 60;

	beforeEach(async () => {
		db = await openTestDb("sqlite");
		// Short timers: the grace and the retention are what these tests wait out.
		// The retention is well above the grace so a slow reconnect still sees the kept buffer.
		cluster = new Cluster(db, { reconnectGraceMs: GRACE_MS, unknownOutputKeepMs: 10 * GRACE_MS });
		identity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		owner = { userId: user.id };
	});

	afterEach(async () => {
		await later?.close();
		await laterAgents?.close();
		later = undefined;
		laterAgents = undefined;
		await cluster.close();
		await agents.close();
		await db.destroy();
	});

	const actor = () => ({ type: "user" as const, id: owner.userId, onBehalfOfUserId: owner.userId });

	const addNode = async (name: string, key: Uint8Array, transport: "client" | "ssh" = "client"): Promise<NodeRow> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("nodes")
			.values({
				id,
				org_id: await defaultOrgId(db),
				name,
				name_key: name.toLowerCase(),
				transport,
				status: "active",
				public_key: Buffer.from(key).toString("base64"),
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
				ssh_host_key: null,
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
				grantee_id: owner.userId,
				target_type: "node",
				target_id: id,
				created_by_user_id: owner.userId,
				created_at: now,
			})
			.execute();
		return (await db.selectFrom("nodes").selectAll().where("id", "=", id).executeTakeFirstOrThrow()) as NodeRow;
	};

	/** Connects a fake crha with no running tasks, as a restarted client would. */
	const connect = async (key: ReturnType<typeof generateKeyPair>): Promise<FakeCrha> => {
		const crha = await agents.connect(key, handshakeInit());
		await crha.peer.request("hello", { tasks: [], taskKinds: [], privilegedMode: "" });
		return crha;
	};

	const view = async (id: string) => {
		const task = await cluster.getTask(id);
		if (!task) throw new Error(`task ${id} disappeared`);
		return task;
	};

	/** A task the node accepted: it is running until the node reports its exit. */
	const running = async (
		node: NodeRow,
		key: ReturnType<typeof generateKeyPair>,
	): Promise<{ crha: FakeCrha; id: string }> => {
		const crha = await connect(key);
		const task = await cluster.createTask({ nodeId: node.id, spec: EXEC, actor: actor() });
		await waitFor("running", async () => (await view(task.id)).state === "running");
		return { crha, id: task.id };
	};

	/** Inserts a task row as a previous process would have left it. */
	const seedTask = async (node: NodeRow, state: "dispatched" | "running"): Promise<string> => {
		const id = newId();
		const now = new Date().toISOString();
		await db
			.insertInto("tasks")
			.values({
				id,
				org_id: node.org_id,
				node_id: node.id,
				task_group_id: null,
				kind: EXEC.kind,
				spec: JSON.stringify(taskSpecToJson(EXEC)),
				input_size: null,
				input_sha256: null,
				privileged: 0,
				attempt: 1,
				timeout_ms: null,
				output_mode: "full",
				state,
				exit_code: null,
				signal: null,
				timed_out: 0,
				cancelled: 0,
				error_code: null,
				error_message: null,
				actor_type: "user",
				actor_id: owner.userId,
				on_behalf_of_user_id: owner.userId,
				created_at: now,
				dispatched_at: now,
				accepted_at: state === "running" ? now : null,
				finished_at: null,
				output_bytes: 0,
				output_head: null,
				output_tail: null,
				notice: null,
				output_file: null,
				late_result: null,
				rule_chain: null,
				approval: null,
				pending_input: null,
				root_session_id: null,
				handler_type: null,
				handler_session_id: null,
			})
			.execute();
		return id;
	};

	describe("a task a previous process left open", () => {
		it("ends a running task as unknown(connection_lost) after the reconnect grace", async () => {
			const key = generateKeyPair();
			const node = await addNode("restart-running", key.publicKey);
			const id = await seedTask(node, "running");

			// The new process finds the row running and no connection: it starts the grace now.
			later = new Cluster(db, { reconnectGraceMs: GRACE_MS });
			await later.recover();
			expect(await later.getTask(id)).toMatchObject({ state: "running" });
			const unknown = await waitFor("unknown after the grace", async () => {
				const task = await later?.getTask(id);
				return task?.state === "unknown" ? task : undefined;
			});
			expect(unknown.errorCode).toBe("connection_lost");
			expect(unknown.finishedAt).not.toBeNull();
		});

		it("ends a task whose start was never confirmed as unknown(dispatch_unconfirmed)", async () => {
			const key = generateKeyPair();
			const node = await addNode("restart-dispatched", key.publicKey);
			const id = await seedTask(node, "dispatched");

			later = new Cluster(db, { reconnectGraceMs: GRACE_MS });
			await later.recover();
			const unknown = await waitFor("unknown after the grace", async () => {
				const task = await later?.getTask(id);
				return task?.state === "unknown" ? task : undefined;
			});
			expect(unknown.errorCode).toBe("dispatch_unconfirmed");
		});

		it("leaves a task of a node that reconnects within the grace alone", async () => {
			const key = generateKeyPair();
			const node = await addNode("restart-reconnect", key.publicKey);
			const id = await seedTask(node, "running");

			// A grace long enough that the reconnect is not racing it on a loaded machine.
			const graceMs = 500;
			later = new Cluster(db, { reconnectGraceMs: graceMs });
			laterAgents = await TestAgentServer.start(db, identity, later);
			await later.recover();
			// The node comes back and reports the task; hello clears the grace and keeps it running.
			const crha = await laterAgents.connect(key, handshakeInit());
			const welcome = await crha.peer.request("hello", {
				tasks: [{ taskId: id, state: "running", outputEnd: 0 }],
				taskKinds: [],
				privilegedMode: "",
			});
			expect(welcome.acks).toEqual([{ taskId: id, offset: 0 }]);
			// The grace it would have had long passes; the task is still running.
			await new Promise((resolve) => setTimeout(resolve, 2 * graceMs));
			expect(await later.getTask(id)).toMatchObject({ state: "running" });

			crha.exit(id, { kind: "code", value: 0 });
			await waitFor("exited", async () => (await later?.getTask(id))?.state === "exited");
		});

		it("ends a running task of an SSH node as unknown(connection_lost) at once", async () => {
			const key = generateKeyPair();
			const node = await addNode("restart-ssh", key.publicKey, "ssh");
			const id = await seedTask(node, "running");

			later = new Cluster(db, { reconnectGraceMs: 600_000 });
			await later.recover();
			// No grace for SSH: the connection died with the process.
			expect(await later.getTask(id)).toMatchObject({ state: "unknown", errorCode: "connection_lost" });
		});
	});

	describe("output kept for an unknown task", () => {
		const OUTPUT = Buffer.from("hello\r\n");

		/** A running task that already pushed `OUTPUT` to crhs. */
		const withOutput = async (
			node: NodeRow,
			key: ReturnType<typeof generateKeyPair>,
		): Promise<{ crha: FakeCrha; id: string }> => {
			const { crha, id } = await running(node, key);
			crha.output(id, 0, OUTPUT);
			await waitFor("output stored", async () => (await view(id)).outputBytes === OUTPUT.length);
			return { crha, id };
		};

		/** Reconnects and reports the task: the welcome's offsets are what crhs still has in memory. */
		const ackOf = async (key: ReturnType<typeof generateKeyPair>, id: string): Promise<number> => {
			const second = await agents.connect(key, handshakeInit());
			const welcome = await second.peer.request("hello", {
				tasks: [{ taskId: id, state: "running", outputEnd: 0 }],
				taskKinds: [],
				privilegedMode: "",
			});
			return welcome.acks[0]?.offset ?? -1;
		};

		const expireByDisconnect = async (crha: FakeCrha, id: string) => {
			crha.ws.close();
			await crha.closed;
			return waitFor("unknown after the grace", async () => {
				const task = await view(id);
				return task.state === "unknown" ? task : undefined;
			});
		};

		it("keeps the output of a grace-timeout unknown for a late result", async () => {
			const key = generateKeyPair();
			const node = await addNode("unknown-kept", key.publicKey);
			const { crha, id } = await withOutput(node, key);
			const unknown = await expireByDisconnect(crha, id);
			expect(unknown.errorCode).toBe("connection_lost");

			// The node comes back and reports the task: crhs still has all its output, so it acks from there.
			expect(await ackOf(key, id)).toBe(OUTPUT.length);
		});

		it("drops the output when the node does not know the task either", async () => {
			const key = generateKeyPair();
			const node = await addNode("unknown-dropped", key.publicKey);
			const { crha, id } = await withOutput(node, key);
			await expireByDisconnect(crha, id);

			// The node reconnects without the task: task.query answers unknown, so no exit can complete it.
			const second = await connect(key);
			await waitFor("task.query", () => second.queries.includes(id));
			expect(await view(id)).toMatchObject({ state: "unknown", errorCode: "connection_lost" });
			second.ws.close();
			await second.closed;

			// A later welcome acks nothing: the buffer is gone.
			expect(await ackOf(key, id)).toBe(0);
		});

		it("drops the output after the retention time even if the node never returns", async () => {
			const key = generateKeyPair();
			const node = await addNode("unknown-expired", key.publicKey);
			const { crha, id } = await withOutput(node, key);
			await expireByDisconnect(crha, id);
			// The cluster keeps it for unknownOutputKeepMs (10 × grace in this suite), then drops it.
			await new Promise((resolve) => setTimeout(resolve, 12 * GRACE_MS));

			expect(await ackOf(key, id)).toBe(0);
		});
	});
});

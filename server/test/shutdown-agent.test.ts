import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@crh/noise";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import type { ServerIdentity } from "../src/cluster/identity.ts";
import { createNodeGroup, setNodeGroupsForNode } from "../src/cluster/node-groups.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type FakeCrha, handshakeInit, TestAgentServer, waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

/**
 * Shutdown closes the agent runtime before it ends the catalog waits (main.ts): a tool call waiting on a
 * cluster task is a durable task, so the Harness aborts it without recording a result, and a restart reruns
 * it, reattaching to the same cluster task (doc/design/agent-runtime.md "exec tool semantics").
 */
describe("agent runtime shutdown", () => {
	let dir: string;
	let db: Db;
	let audit: Audit;
	let cluster: Cluster;
	let groups: TaskGroups;
	let agents: TestAgentServer;
	let fake: FakeCrha;
	let models: ModelConfig;
	let runtime: AgentRuntime;
	let owner: SessionUser;
	let sessionId: string;
	let nodeId: string;
	let consoleErrors: string[];
	const faux = fauxProvider();
	const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
	const openStorage = () => openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" });

	const openRuntime = () => AgentRuntime.open({ db, storage: openStorage, models, cluster, taskGroups: groups, audit });

	/** Reads the durable store directly: entries and task records, as a restart would find them. */
	const inspectDurable = async (): Promise<{ entries: EntryRecord[]; tasks: { kind: string; status: string }[] }> => {
		const conversationId = (
			await db.selectFrom("sessions").select("conversation_id").where("id", "=", sessionId).executeTakeFirstOrThrow()
		).conversation_id;
		const storage: Storage = await openStorage();
		try {
			const entries = await storage.scanEntries(
				{ conversationId: Number(conversationId) as never },
				1_000,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const tasks = await storage.scanTasks(
				{ conversationId: Number(conversationId) as never },
				100,
				undefined,
				BACKGROUND_CONTEXT,
			);
			return {
				entries: [...entries.items],
				tasks: tasks.items.map((task) => ({ kind: task.kind, status: task.state.status })),
			};
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "crh-shutdown-agent-"));
		db = await openTestDb("sqlite");
		audit = new Audit(db);
		cluster = new Cluster(db, { audit, reconnectGraceMs: 600_000 });
		groups = new TaskGroups(db, cluster, { audit });
		models = new ModelConfig(db, MasterKey.generate());
		models.addProvider(faux.provider);
		await models.reload();
		runtime = await openRuntime();

		const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
		owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
		const key = generateKeyPair();
		nodeId = newId();
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
				trust_report: null,
				trust_digest: null,
				trust_updated_at: null,
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
				target_id: nodeId,
				created_by_user_id: owner.userId,
				created_at: now,
			})
			.execute();
		const batch = await createNodeGroup(db, await defaultOrgId(db), "batch");
		await setNodeGroupsForNode(db, nodeId, [batch.id]);
		const identity: ServerIdentity = { keyPair: generateKeyPair(), fingerprint: "test-fingerprint" };
		agents = await TestAgentServer.start(db, identity, cluster);
		fake = await agents.connect(key, handshakeInit());
		expect(await fake.peer.request("hello", { tasks: [], taskKinds: [], privilegedMode: "" })).toEqual({ acks: [] });
		await waitFor("node connected", () => cluster.isConnected(nodeId));

		sessionId = (await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "shutdown" })).id;
		consoleErrors = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleErrors.push(args.map(String).join(" "));
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await runtime.close();
		cluster.endWaits();
		groups.endWaits();
		await cluster.close();
		await groups.close();
		await agents.close();
		await db.destroy();
		await rm(dir, { recursive: true, force: true });
	});

	it("aborts a tool call waiting on a task without an outcome and reruns it after a restart", async () => {
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { targets: ["web-1"], cmd: "sleep 60", wait: 600 }, { id: "call-1" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const submissionId = await runtime.submit(sessionId, owner, "run it", "r1");
		const taskId = (await waitFor("the task start", () => fake.starts[0], 10_000)).taskId;
		await waitFor("the task running", async () => (await cluster.getTask(taskId))?.state === "running");
		// Let the tool call enter its wait before the runtime closes.
		await new Promise((resolve) => setTimeout(resolve, 100));

		// The shutdown order: close the runtime, and only then end the waits.
		const started = Date.now();
		await runtime.close();
		cluster.endWaits();
		groups.endWaits();
		// The Harness aborted the call through its signal; ending the waits is not what released it.
		expect(Date.now() - started).toBeLessThan(5_000);

		const closed = await inspectDurable();
		expect(closed.entries.filter((entry) => entry.kind === "pi.tool-result")).toEqual([]);
		// A close is not a crash: the tool task is pending again, not finished with an outcome.
		expect(closed.tasks.find((task) => task.kind === "pi.tool")).toMatchObject({ status: "pending" });

		// A restart on the same storage reruns the call; it reattaches to the task it already started.
		runtime = await openRuntime();
		expect(await waitSubmission(runtime, sessionId, submissionId)).toEqual({ status: "done", answer: "done" });
		expect(fake.starts).toHaveLength(1);
		const tasks = await db.selectFrom("tasks").select(["id", "state"]).where("actor_id", "=", sessionId).execute();
		expect(tasks).toEqual([{ id: taskId, state: "running" }]);
		const rerun = await inspectDurable();
		const results = rerun.entries.filter((entry) => entry.kind === "pi.tool-result");
		expect(results).toHaveLength(1);
		// The model saw the one task's result, not a second task's.
		expect(JSON.stringify(results[0]?.model)).toContain(taskId);
		expect(consoleErrors).toEqual([]);
	}, 20_000);

	it("ends a tool call waiting on a task group when the runtime closes", async () => {
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { targets: ["batch"], cmd: "sleep 60", wait: 600 }, { id: "call-1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const submissionId = await runtime.submit(sessionId, owner, "run it", "r1");
		const taskId = (await waitFor("the group's task start", () => fake.starts[0], 10_000)).taskId;
		await waitFor("the group's task running", async () => (await cluster.getTask(taskId))?.state === "running");
		await new Promise((resolve) => setTimeout(resolve, 100));

		// The group wait is not woken by endWaits (that comes after the close): the call's signal must end it.
		const started = Date.now();
		await runtime.close();
		cluster.endWaits();
		groups.endWaits();
		expect(Date.now() - started).toBeLessThan(5_000);
		const closed = await inspectDurable();
		expect(closed.entries.filter((entry) => entry.kind === "pi.tool-result")).toEqual([]);

		// The restart reruns the call; the group was created with a derived id, so no second group or task exists.
		runtime = await openRuntime();
		expect(await waitSubmission(runtime, sessionId, submissionId)).toEqual({ status: "done", answer: "done" });
		expect(fake.starts).toHaveLength(1);
		const groupsOf = await db
			.selectFrom("task_groups")
			.select(["id", "state"])
			.where("actor_id", "=", sessionId)
			.execute();
		expect(groupsOf).toHaveLength(1);
		const tasks = await db.selectFrom("tasks").select(["id", "state"]).where("actor_id", "=", sessionId).execute();
		expect(tasks).toEqual([{ id: taskId, state: "running" }]);
		const results = (await inspectDurable()).entries.filter((entry) => entry.kind === "pi.tool-result");
		expect(results).toHaveLength(1);
		expect(JSON.stringify(results[0]?.model)).toContain(taskId);
	}, 20_000);

	it("refuses a session request while the runtime is closing", async () => {
		const app: App = makeApp(db, undefined, {
			cluster,
			audit,
			masterKey: MasterKey.generate(),
			agent: { runtime, models },
		});
		const cookie = await login(app, "owner", "password-123");
		await runtime.close();

		const message = await call(app, `/api/sessions/${sessionId}/messages`, {
			cookie,
			body: { text: "hi", requestId: "r1" },
		});
		expect(message.status).toBe(503);
		expect(await message.json()).toEqual({ error: "server is shutting down" });
		const created = await call(app, "/api/sessions", {
			cookie,
			body: { requestId: "closing", message: "hi", model: model() },
		});
		expect(created.status).toBe(503);
		// A clean error: no closed-Harness exception reached Hono's default handler.
		expect(consoleErrors).toEqual([]);
	}, 10_000);
});

import type { TaskSpec } from "@crh/protocol";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { setQuota } from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { markSessionsIdle, sessionStateOf, setSessionState } from "../src/agent/session-state.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";
import { createNodeGroup, setNodeGroupsForNode } from "../src/cluster/node-groups.ts";
import { TaskGroups, type TaskGroupView } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Session state (D97, doc/agent-runtime.md#会话状态): idle / running / awaiting for roots and subagents
 * alike, the waiting kind and its priority, no revival after idle, and the startup reconciliation.
 */

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
	what: string,
	probe: () => Promise<T | undefined> | T | undefined,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

let db: Db;
let runtime: AgentRuntime;
let cluster: Cluster;
let groups: TaskGroups;
let audit: Audit;
let owner: SessionUser;
let nodeId = "";

const TASK: TaskSpec = {
	kind: "exec",
	command: { argv: ["true"] },
	env: {},
	cwd: "",
	stdin: null,
};

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	groups = new TaskGroups(db, cluster, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups: groups,
		audit,
	});
	const user = await createUser(db, { username: "state-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
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
			public_key: null,
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
			target_id: nodeId,
			created_by_user_id: owner.userId,
			created_at: now,
		})
		.execute();
	// A group of one node: naming the group is a task group, naming the node is a single task.
	const batch = await createNodeGroup(db, await defaultOrgId(db), "batch");
	await setNodeGroupsForNode(db, nodeId, [batch.id]);
});

afterAll(async () => {
	await runtime.close();
	cluster.endWaits();
	groups.endWaits();
	await cluster.close();
	await groups.close();
	await db.destroy();
});

const rowOf = async (id: string) =>
	db
		.selectFrom("sessions")
		.select(["state", "waiting_kind", "waiting_level_id", "waiting_handler_id"])
		.where("id", "=", id)
		.executeTakeFirstOrThrow();

const taskOf = async (id: string) => (await cluster.getTask(id)) as TaskView;
const groupOf = async (id: string) => (await groups.get(id)) as TaskGroupView;

it("a root runs while its latest input runs and is idle when it ends", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "yolo", title: "root states" });
	expect(session.state).toBe("idle");
	expect(session.waitingKind).toBeNull();
	faux.setResponses([
		async () => {
			await sleep(150);
			return fauxAssistantMessage([fauxText("done")]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "go", "root-state-1");
	await waitFor("running", async () => ((await sessionStateOf(db, session.id)) === "running" ? true : undefined));
	expect(await runtime.getSession(session.id)).toMatchObject({ state: "running", waitingKind: null });
	await waitSubmission(runtime, session.id, submission);
	await waitFor("idle after the run", async () =>
		(await sessionStateOf(db, session.id)) === "idle" ? true : undefined,
	);
	expect(await runtime.getSession(session.id)).toMatchObject({ state: "idle", waitingKind: null });
});

it("a subagent runs while its input runs and is idle when it ends", async () => {
	const parent = await runtime.createSession(owner, { model: model(), preset: "yolo", title: "child states" });
	const child = await runtime.createSubagent(parent.id, {
		callKey: "state-child",
		task: "child work",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	expect(await sessionStateOf(db, child.id)).toBe("idle");
	faux.setResponses([
		async () => {
			await sleep(150);
			return fauxAssistantMessage([fauxText("done")]);
		},
	]);
	await runtime.startSubagent(child.id, "work", "child-state-1");
	await waitFor("the child running", async () =>
		(await sessionStateOf(db, child.id)) === "running" ? true : undefined,
	);
	expect(await runtime.waitSubagent(child.id)).toEqual({ status: "done", answer: "done" });
	await waitFor("the child idle", async () => ((await sessionStateOf(db, child.id)) === "idle" ? true : undefined));
});

it("an exhausted root quota makes it awaiting/quota; a grant resumes the run and it ends idle", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		preset: "yolo",
		title: "root quota states",
		budgetRemaining: 1,
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "quota-state-tool" })], { stopReason: "toolUse" }),
		async () => {
			await sleep(200);
			return fauxAssistantMessage([fauxText("after the grant")]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "go", "root-quota-state");
	await waitFor("the quota wait", async () =>
		(await sessionStateOf(db, session.id)) === "awaiting" ? true : undefined,
	);
	expect(await rowOf(session.id)).toMatchObject({
		state: "awaiting",
		waiting_kind: "quota",
		waiting_level_id: session.id,
	});
	expect(await runtime.getSession(session.id)).toMatchObject({
		state: "awaiting",
		waitingKind: "quota",
		waitingLevelId: session.id,
	});
	expect(await runtime.decideRootQuota(session.id, "approve", 100_000)).toEqual([session.id]);
	await waitFor("running after the grant", async () =>
		(await sessionStateOf(db, session.id)) === "running" ? true : undefined,
	);
	await waitSubmission(runtime, session.id, submission);
	await waitFor("idle after the run", async () =>
		(await sessionStateOf(db, session.id)) === "idle" ? true : undefined,
	);
});

it("a tool call waiting for an approval makes the session awaiting/approval, then running, then idle", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "ask", title: "approval states" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("exec", { targets: ["web-1"], cmd: "true" }, { id: "approval-state-tool" })], {
			stopReason: "toolUse",
		}),
		async () => {
			await sleep(250);
			return fauxAssistantMessage([fauxText("after the approval")]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "run it", "approval-state-1");
	const task = await waitFor("the waiting task", async () => {
		const row = await db
			.selectFrom("tasks")
			.select("id")
			.where("actor_id", "=", session.id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		return row?.id;
	});
	await waitFor("awaiting/approval", async () => {
		const row = await rowOf(session.id);
		return row.state === "awaiting" && row.waiting_kind === "approval" ? true : undefined;
	});
	expect(await runtime.getSession(session.id)).toMatchObject({ state: "awaiting", waitingKind: "approval" });
	expect(
		await cluster.decide(task, {
			decision: "approved",
			by: { type: "user", id: owner.userId },
			at: new Date().toISOString(),
		}),
	).toBe(true);
	await waitFor("running after the approval", async () =>
		(await sessionStateOf(db, session.id)) === "running" ? true : undefined,
	);
	await waitSubmission(runtime, session.id, submission);
	await waitFor("idle after the run", async () =>
		(await sessionStateOf(db, session.id)) === "idle" ? true : undefined,
	);
	expect((await taskOf(task)).state).toBe("failed"); // the node is offline in this test
});

it("a task that has not been dispatched yet is not an approval wait", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "ask", title: "dispatch transient" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxText("done")]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "work", "dispatch-transient-1");
	await waitFor("the run live", async () => ((await sessionStateOf(db, session.id)) === "running" ? true : undefined));
	const task = await cluster.createTask({
		nodeId,
		spec: TASK,
		chain: [{ type: "session", id: session.id }],
		actor: { type: "session", id: session.id, onBehalfOfUserId: owner.userId },
	});
	expect(task.state).toBe("awaiting_approval");
	// The shape createTask writes for an allowed task: awaiting_approval only until the dispatch, no handler.
	await db.updateTable("tasks").set({ handler_type: null }).where("id", "=", task.id).execute();
	await runtime.refreshState(session.id);
	expect(await runtime.getSession(session.id)).toMatchObject({ state: "running", waitingKind: null });
	// The same row with a handler is a pending approval, and the session waits for it.
	await db.updateTable("tasks").set({ handler_type: "user" }).where("id", "=", task.id).execute();
	await runtime.refreshState(session.id);
	expect(await runtime.getSession(session.id)).toMatchObject({ state: "awaiting", waitingKind: "approval" });
	release();
	await waitSubmission(runtime, session.id, submission);
});

it("a task waiting for a signature makes the session awaiting/authorization", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		preset: "ask",
		title: "authorization states",
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxText("signed and done")]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "privileged work", "authorization-state-1");
	await waitFor("the run live", async () => ((await sessionStateOf(db, session.id)) === "running" ? true : undefined));
	const task = await cluster.createTask({
		nodeId,
		spec: TASK,
		chain: [{ type: "session", id: session.id }],
		actor: { type: "session", id: session.id, onBehalfOfUserId: owner.userId },
	});
	// The cluster reports the state change; the runtime recomputes the session from it (doc/agent-runtime.md#会话状态).
	await db.updateTable("tasks").set({ state: "awaiting_authorization" }).where("id", "=", task.id).execute();
	cluster.onChange?.(session.id);
	await waitFor("awaiting/authorization", async () => {
		const row = await rowOf(session.id);
		return row.state === "awaiting" && row.waiting_kind === "authorization" ? true : undefined;
	});
	expect(await runtime.getSession(session.id)).toMatchObject({ state: "awaiting", waitingKind: "authorization" });
	// Once the signature is in, the task runs and the session is running again.
	await db.updateTable("tasks").set({ state: "running" }).where("id", "=", task.id).execute();
	cluster.onChange?.(session.id);
	await waitFor("running after the signature", async () =>
		(await sessionStateOf(db, session.id)) === "running" ? true : undefined,
	);
	release();
	await waitSubmission(runtime, session.id, submission);
	await waitFor("idle after the run", async () =>
		(await sessionStateOf(db, session.id)) === "idle" ? true : undefined,
	);
});

it("a task group waiting for approval is the session's approval wait too", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "ask", title: "group states" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("exec", { targets: ["batch"], cmd: "true" }, { id: "group-state-tool" })], {
			stopReason: "toolUse",
		}),
		async () => {
			await sleep(250);
			return fauxAssistantMessage([fauxText("after the group")]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "run it", "group-state-1");
	const group = await waitFor("the waiting group", async () => {
		const row = await db
			.selectFrom("task_groups")
			.select("id")
			.where("actor_id", "=", session.id)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		return row?.id;
	});
	await waitFor("awaiting/approval", async () => {
		const row = await rowOf(session.id);
		return row.state === "awaiting" && row.waiting_kind === "approval" ? true : undefined;
	});
	expect(
		await groups.decide(group, {
			decision: "approved",
			by: { type: "user", id: owner.userId },
			at: new Date().toISOString(),
		}),
	).toBe(true);
	await waitFor("running after the group", async () =>
		(await sessionStateOf(db, session.id)) === "running" ? true : undefined,
	);
	await waitSubmission(runtime, session.id, submission);
	await waitFor("idle after the run", async () =>
		(await sessionStateOf(db, session.id)) === "idle" ? true : undefined,
	);
	expect((await groupOf(group)).state).toBe("finished");
});

it("overlapping waits use quota > approval > authorization, and a read never revives idle", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "ask", title: "overlap states" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage([fauxText("finished")]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "wait for decisions", "overlap-state-1");
	await waitFor("the run live", async () => ((await sessionStateOf(db, session.id)) === "running" ? true : undefined));
	const createWaiting = async () =>
		cluster.createTask({
			nodeId,
			spec: TASK,
			chain: [{ type: "session", id: session.id }],
			actor: { type: "session", id: session.id, onBehalfOfUserId: owner.userId },
		});

	// A waiting approval outranks a waiting signature.
	const authorization = await createWaiting();
	await db.updateTable("tasks").set({ state: "awaiting_authorization" }).where("id", "=", authorization.id).execute();
	expect(await runtime.refreshState(session.id)).toBe("awaiting");
	expect(await rowOf(session.id)).toMatchObject({ state: "awaiting", waiting_kind: "authorization" });
	const approval = await createWaiting();
	await waitFor("awaiting/approval", async () => {
		const row = await rowOf(session.id);
		return row.state === "awaiting" && row.waiting_kind === "approval" ? true : undefined;
	});

	// An exhausted quota outranks both; restoring it falls back to the remaining approval.
	await setQuota(db, session.id, 0);
	await setSessionState(db, session.id, "awaiting", { kind: "quota", levelId: session.id });
	expect(await runtime.refreshState(session.id)).toBe("awaiting");
	expect(await rowOf(session.id)).toMatchObject({ state: "awaiting", waiting_kind: "quota" });
	await setQuota(db, session.id, 100_000);
	expect(await runtime.refreshState(session.id)).toBe("awaiting");
	expect(await rowOf(session.id)).toMatchObject({ state: "awaiting", waiting_kind: "approval" });

	// Each decision recomputes the remaining waits; the last one lets the run go on.
	await cluster.decide(approval.id, {
		decision: "rejected",
		by: { type: "user", id: owner.userId },
		at: new Date().toISOString(),
	});
	expect(await runtime.refreshState(session.id)).toBe("awaiting");
	expect(await rowOf(session.id)).toMatchObject({ state: "awaiting", waiting_kind: "authorization" });
	await cluster.cancelTask(authorization.id);
	expect(await runtime.refreshState(session.id)).toBe("running");

	// A run that has ended is idle and neither a read nor a new wait revives it.
	await markSessionsIdle(db, [session.id]);
	expect(await runtime.refreshState(session.id)).toBe("idle");
	const late = await createWaiting();
	expect(await runtime.refreshState(session.id)).toBe("idle");
	await cluster.cancelTask(late.id);

	release();
	await waitSubmission(runtime, session.id, submission);
	await waitFor("idle after the run", async () =>
		(await sessionStateOf(db, session.id)) === "idle" ? true : undefined,
	);
});

import { create } from "@bufbuild/protobuf";
import { TaskSpecSchema } from "@crh/protocol";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

/** Background subagents and the parent agent's handling of their approvals (doc/agent-runtime.md#subagent). */
let db: Db;
let cluster: Cluster;
let audit: Audit;
let runtime: AgentRuntime;
let owner: SessionUser;
let nodeId = "";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		groups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	nodeId = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id: nodeId,
			org_id: await defaultOrgId(db),
			owner_user_id: user.id,
			name: "web-1",
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
});

afterAll(async () => {
	await runtime.close();
	cluster.close();
	await db.destroy();
});

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

const subagent = (parentId: string, callKey: string, rules: { default: string; rules: unknown[] }) =>
	runtime.createSubagent(parentId, { callKey, task: `task ${callKey}`, rules: rules as never, quota: null });

const execTask = (chain: string[]) =>
	cluster.createTask({
		nodeId,
		spec: create(TaskSpecSchema, { kind: { case: "exec", value: { argv: ["echo", "hi"] } } }),
		chain: chain.map((id) => ({ type: "session" as const, id })),
		actor: { type: "subagent", id: chain[chain.length - 1] as string, onBehalfOfUserId: owner.userId },
	});

const approvalOf = async (id: string) => {
	const task = (await cluster.getTask(id)) as TaskView;
	return task.approval as {
		decision?: { by: { type: string; id: string } };
		agent?: { session: string; state: string };
	} | null;
};

it("runs a subagent in the background and waits for its answer", async () => {
	const parent = await runtime.createSession(owner, { model: model(), preset: "yolo" });
	const child = await subagent(parent.id, "bg-1", { default: "inherit", rules: [] });
	expect(child.created).toBe(true);
	// Idempotent: the same tool call finds the same session.
	expect((await subagent(parent.id, "bg-1", { default: "inherit", rules: [] })).created).toBe(false);

	faux.setResponses([fauxAssistantMessage([fauxText("background answer")])]);
	const submission = await runtime.startSubagent(child.id, "do the thing", "subagent:bg-1");
	expect(submission).toBeTruthy();
	expect(await runtime.waitSubagent(child.id)).toEqual({ status: "done", answer: "background answer" });

	const children = await runtime.subagentSessions(parent.id);
	expect(children.map((c) => c.id)).toEqual([child.id]);
	expect(await runtime.isDescendant(parent.id, child.id)).toBe(true);
	expect(await runtime.isDescendant(child.id, parent.id)).toBe(false);
});

it("nests at most two levels below a root session", async () => {
	const root = await runtime.createSession(owner, { model: model(), preset: "yolo" });
	const first = await subagent(root.id, "depth-1", { default: "inherit", rules: [] });
	const second = await subagent(first.id, "depth-2", { default: "inherit", rules: [] });
	await expect(subagent(second.id, "depth-3", { default: "inherit", rules: [] })).rejects.toThrow(/at most 2/);
});

it("hands a grandchild's approval to the parent agent and wakes it", async () => {
	const root = await runtime.createSession(owner, { model: model(), preset: "yolo" });
	const parent = await subagent(root.id, "route-parent", { default: "inherit", rules: [] });
	const child = await subagent(parent.id, "route-child", { default: "require-approval", rules: [] });

	const wake: string[] = [];
	const stop = await runtime.watch(parent.id, (events) => {
		for (const event of events) if (event.type === "message_end") wake.push(JSON.stringify(event.entry));
	});
	try {
		faux.setResponses([fauxAssistantMessage([fauxText("noted")])]);
		const task = await execTask([root.id, parent.id, child.id]);
		expect(task.state).toBe("awaiting_approval");
		const request = await waitFor("the routed request", async () =>
			(await runtime.pendingAgentRequests(parent.id)).find((r) => r.id === task.id),
		);
		expect(request).toMatchObject({ kind: "task", sessionId: child.id });
		expect((await approvalOf(task.id))?.agent).toEqual({ session: parent.id, state: "pending" });
		// The idle parent was woken with a follow-up input naming the request.
		await waitFor("the parent's wake input", async () =>
			wake.some((entry) => entry.includes(task.id) && entry.includes("subagent request")) ? true : undefined,
		);

		expect(await runtime.decideAgentRequest(parent.id, task.id, "approve", "looks fine")).toBe("task");
		const approval = await approvalOf(task.id);
		expect(approval?.decision).toMatchObject({ by: { type: "subagent", id: parent.id } });
		expect(await runtime.pendingAgentRequests(parent.id)).toHaveLength(0);
	} finally {
		stop();
	}
});

it("can deny or escalate a request; escalating leaves it for the user", async () => {
	const root = await runtime.createSession(owner, { model: model(), preset: "yolo" });
	const parent = await subagent(root.id, "decide-parent", { default: "inherit", rules: [] });
	const child = await subagent(parent.id, "decide-child", { default: "require-approval", rules: [] });

	const denied = await execTask([root.id, parent.id, child.id]);
	await waitFor("the first request", async () =>
		(await runtime.pendingAgentRequests(parent.id)).find((r) => r.id === denied.id),
	);
	expect(await runtime.decideAgentRequest(parent.id, denied.id, "deny", "too risky")).toBe("task");
	const deniedTask = (await cluster.getTask(denied.id)) as TaskView;
	expect(deniedTask.state).toBe("rejected");
	expect(deniedTask.errorMessage).toBe("too risky");

	const escalated = await execTask([root.id, parent.id, child.id]);
	await waitFor("the second request", async () =>
		(await runtime.pendingAgentRequests(parent.id)).find((r) => r.id === escalated.id),
	);
	expect(await runtime.decideAgentRequest(parent.id, escalated.id, "escalate")).toBe("task");
	const escalatedTask = (await cluster.getTask(escalated.id)) as TaskView;
	expect(escalatedTask.state).toBe("awaiting_approval");
	expect((await approvalOf(escalated.id))?.agent).toEqual({ session: parent.id, state: "escalated" });
	expect(await runtime.pendingAgentRequests(parent.id)).toHaveLength(0);

	// Only the session the request was routed to may settle it.
	await expect(runtime.decideAgentRequest(child.id, escalated.id, "approve")).rejects.toThrow();
});

it("does not hand a request to an agent whose own rules demand approval", async () => {
	const root = await runtime.createSession(owner, { model: model(), preset: "yolo" });
	const parent = await subagent(root.id, "strict-parent", { default: "require-approval", rules: [] });
	const child = await subagent(parent.id, "strict-child", { default: "require-approval", rules: [] });
	const task = await execTask([root.id, parent.id, child.id]);
	expect(task.state).toBe("awaiting_approval");
	await new Promise((r) => setTimeout(r, 200));
	expect(await runtime.pendingAgentRequests(parent.id)).toHaveLength(0);
	expect((await approvalOf(task.id))?.agent).toBeUndefined();
});

it("a subagent waiting for approval is awaiting, and active again once settled", async () => {
	const root = await runtime.createSession(owner, { model: model(), preset: "yolo" });
	const parent = await subagent(root.id, "state-parent", { default: "inherit", rules: [] });
	const child = await subagent(parent.id, "state-child", { default: "require-approval", rules: [] });
	const task = await execTask([root.id, parent.id, child.id]);
	await waitFor("awaiting", async () => ((await runtime.refreshState(child.id)) === "awaiting" ? true : undefined));
	expect((await runtime.getSession(child.id))?.state).toBe("awaiting");
	expect(await runtime.decideAgentRequest(parent.id, task.id, "approve")).toBe("task");
	expect(await runtime.refreshState(child.id)).toBe("active");
});

it("stopping a session stops its subagents", async () => {
	const parent = await runtime.createSession(owner, { model: model(), preset: "yolo" });
	const child = await subagent(parent.id, "cancel-child", { default: "inherit", rules: [] });
	faux.setResponses([fauxAssistantMessage([fauxText("never seen")])]);
	await runtime.startSubagent(child.id, "long work", "subagent:cancel-child");
	await runtime.abort(parent.id, owner);
	const result = await runtime.waitSubagent(child.id);
	expect(result.status).toBe("unanswered");
});

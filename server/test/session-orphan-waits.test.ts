import type { TaskSpec } from "@crh/protocol";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { type Actor, AUTHORIZATION_WAIT_MS, Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";
import { type DbProbe, probeDb, tableOf } from "./helpers/db-probe.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Waits nobody can act on (doc/agent-runtime.md#会话状态, doc/privilege.md#等待签名的期限): a stopped session
 * ends its approval and signature waits, so does a run that ended without its task, the startup reconciliation
 * ends the waits of sessions whose run is over, and a signature wait expires after AUTHORIZATION_WAIT_MS.
 */

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

const TASK: TaskSpec = { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null };

let db: Db;
let dbProbe: DbProbe;
let cluster: Cluster;
let groups: TaskGroups;
let models: ModelConfig;
let runtime: AgentRuntime;
let owner: SessionUser;
let nodeId = "";

async function openRuntime(): Promise<AgentRuntime> {
	return AgentRuntime.open({
		db: dbProbe.db,
		storage: new MemoryStorage(),
		models,
		cluster,
		groups,
		audit: new Audit(db),
	});
}

beforeEach(async () => {
	db = await openTestDb("sqlite");
	dbProbe = probeDb(db);
	const audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	groups = new TaskGroups(db, cluster, { audit });
	models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await openRuntime();
	const user = await createUser(db, { username: "orphan-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	nodeId = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id: nodeId,
			org_id: await defaultOrgId(db),
			owner_user_id: user.id,
			name: "db-1",
			transport: "client",
			status: "active",
			public_key: null,
			hostname: "db-1",
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

afterEach(async () => {
	await runtime.close();
	cluster.endWaits();
	groups.endWaits();
	await cluster.close();
	await groups.close();
	await db.destroy();
});

const taskRow = (id: string) =>
	db
		.selectFrom("tasks")
		.select(["state", "cancelled", "error_code", "error_message"])
		.where("id", "=", id)
		.executeTakeFirstOrThrow();

/** A task acting for `actor`, parked in `state` the way the cluster parks it. */
async function waitingTask(
	actor: { type: Actor["type"]; id: string },
	state: "awaiting_approval" | "awaiting_authorization",
): Promise<string> {
	const task = await cluster.createTask({
		nodeId,
		spec: TASK,
		chain: actor.type === "user" ? undefined : [{ type: "session", id: actor.id }],
		actor: { ...actor, onBehalfOfUserId: owner.userId },
	});
	await db.updateTable("tasks").set({ state }).where("id", "=", task.id).execute();
	return task.id;
}

/** A task group of the session whose one member waits for its signature. */
async function waitingGroup(sessionId: string): Promise<{ groupId: string; memberId: string }> {
	const groupId = await groups.create({
		targets: ["db-1"],
		nodeIds: [nodeId],
		spec: TASK,
		actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
	});
	// The group dispatches its members asynchronously; park one directly the way the cluster parks a member.
	const member = await cluster.createTask({
		nodeId,
		spec: TASK,
		taskGroupId: groupId,
		actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
	});
	await db.updateTable("tasks").set({ state: "awaiting_authorization" }).where("id", "=", member.id).execute();
	await db.updateTable("task_groups").set({ state: "awaiting_authorization" }).where("id", "=", groupId).execute();
	return { groupId, memberId: member.id };
}

/** A session with a run that stays open until `release` is called. */
async function liveSession(title: string) {
	const session = await runtime.createSession(owner, { model: model(), preset: "ask", title });
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
	const submission = await runtime.submit(session.id, owner, "work", `${title}-1`);
	await waitFor("the run live", async () => ((await sessionStateOf(db, session.id)) === "running" ? true : undefined));
	return { session, submission, release };
}

it("stopping a session ends its signature waits, single tasks and group members alike", async () => {
	const { session, release } = await liveSession("stop");
	const approval = await waitingTask({ type: "session", id: session.id }, "awaiting_approval");
	const signature = await waitingTask({ type: "session", id: session.id }, "awaiting_authorization");
	const { groupId, memberId } = await waitingGroup(session.id);

	// The faux model ignores the abort signal, so the gated response is released while the stop is underway.
	const stopping = runtime.abort(session.id, owner);
	release();
	await stopping;

	expect(await taskRow(approval)).toMatchObject({ state: "rejected" });
	expect(await taskRow(signature)).toMatchObject({
		state: "rejected",
		cancelled: 1,
		error_code: "cancelled",
		error_message: "the session was stopped",
	});
	expect(await taskRow(memberId)).toMatchObject({ state: "rejected", error_message: "the session was stopped" });
	await waitFor("the group settled", async () => {
		const group = await db.selectFrom("task_groups").select("state").where("id", "=", groupId).executeTakeFirst();
		return group && group.state !== "awaiting_authorization" ? true : undefined;
	});
});

it("a run that ends without its task ends the task's signature wait", async () => {
	const { session, submission, release } = await liveSession("ended");
	// The tool call is gone (aborted by durable, abandoned after restarts) but its task still waits.
	const signature = await waitingTask({ type: "session", id: session.id }, "awaiting_authorization");
	release();
	await runtime.waitSubmission(session.id, submission);
	await waitFor("the wait ended", async () => ((await taskRow(signature)).state === "rejected" ? true : undefined));
	expect(await taskRow(signature)).toMatchObject({ cancelled: 1, error_message: "the session's run ended" });
	expect(await sessionStateOf(db, session.id)).toBe("idle");
});

it("startup ends the waits of idle sessions and leaves a user's own task alone", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "ask", title: "restart" });
	const approval = await waitingTask({ type: "session", id: session.id }, "awaiting_approval");
	const signature = await waitingTask({ type: "session", id: session.id }, "awaiting_authorization");
	const { memberId } = await waitingGroup(session.id);
	const users = await waitingTask({ type: "user", id: owner.userId }, "awaiting_authorization");
	expect(await sessionStateOf(db, session.id)).toBe("idle");

	await runtime.close();
	runtime = await openRuntime();

	expect(await taskRow(approval)).toMatchObject({ state: "rejected" });
	expect(await taskRow(signature)).toMatchObject({ state: "rejected", error_message: "the session's run ended" });
	expect(await taskRow(memberId)).toMatchObject({ state: "rejected", error_message: "the session's run ended" });
	expect(await taskRow(users)).toMatchObject({ state: "awaiting_authorization" });
});

it("a signature wait expires AUTHORIZATION_WAIT_MS after it began", async () => {
	const old = await waitingTask({ type: "user", id: owner.userId }, "awaiting_authorization");
	const young = await waitingTask({ type: "user", id: owner.userId }, "awaiting_authorization");
	const approvedLate = await waitingTask({ type: "user", id: owner.userId }, "awaiting_authorization");
	const now = Date.now();
	const iso = (ms: number) => new Date(ms).toISOString();
	await db
		.updateTable("tasks")
		.set({ created_at: sql`${iso(now - AUTHORIZATION_WAIT_MS - 60_000)}` })
		.where("id", "in", [old, approvedLate])
		.execute();
	// Approved an hour ago: the wait began at the decision, not at creation.
	await db
		.updateTable("tasks")
		.set({
			approval: JSON.stringify({
				evaluation: { decision: "require-approval", chain: [] },
				decision: { decision: "approved", by: { type: "user", id: owner.userId }, at: iso(now - 3_600_000) },
			}),
		})
		.where("id", "=", approvedLate)
		.execute();

	expect(await cluster.expireAuthorizationWaits(now)).toBe(1);
	expect(await taskRow(old)).toMatchObject({ state: "rejected", error_code: "authorization_wait_expired" });
	expect(await taskRow(young)).toMatchObject({ state: "awaiting_authorization" });
	expect(await taskRow(approvedLate)).toMatchObject({ state: "awaiting_authorization" });
	expect(await cluster.expireAuthorizationWaits(now + AUTHORIZATION_WAIT_MS)).toBe(2);
});

it("stops a subagent's freshly dispatched command instead of leaving it waiting", async () => {
	const parent = await runtime.createSession(owner, { model: model(), preset: "ask", title: "stop-parent" });
	const child = await runtime.createSubagent(parent.id, {
		callKey: "stop-child",
		task: "run something",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	let asked!: () => void;
	const asking = new Promise<void>((resolve) => {
		asked = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			asked();
			await gate;
			return fauxAssistantMessage([fauxToolCall("exec", { targets: ["db-1"], cmd: "true" }, { id: "stop-exec" })], {
				stopReason: "toolUse",
			});
		},
	]);
	await runtime.startSubagent(child.id, "go", "subagent:stop-child");
	await asking;

	let released = false;
	const free = () => {
		if (released) return;
		released = true;
		release();
	};
	// The stop writes the sessions idle after #endSessionWork. Releasing the subagent's answer there is inside the
	// window the old order left; waiting for its task keeps the stop from cutting the tool off first.
	dbProbe.onNext(
		(node) => node.kind === "UpdateQueryNode" && tableOf(node) === "sessions",
		async () => {
			free();
			const deadline = Date.now() + 1_000;
			while (Date.now() < deadline) {
				const row = await db.selectFrom("tasks").select("id").where("actor_id", "=", child.id).executeTakeFirst();
				if (row) return;
				await sleep(20);
			}
		},
	);
	const stopping = runtime.abort(parent.id, owner);
	// With the fix the subagent is aborted before that write and its answer is awaited there: let it through.
	const fallback = setTimeout(free, 300);
	try {
		await stopping;
	} finally {
		clearTimeout(fallback);
	}
	free();

	const rows = await db.selectFrom("tasks").select(["id", "state"]).where("actor_id", "=", child.id).execute();
	expect(
		rows.filter((row) => ["awaiting_approval", "awaiting_authorization", "dispatched", "running"].includes(row.state)),
	).toEqual([]);
});

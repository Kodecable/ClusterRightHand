import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSpec } from "@crh/protocol";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { externalCallId } from "../src/extensions/external-calls.ts";
import { assertJobLimit } from "../src/jobs/limits.ts";
import type { JobRow } from "../src/jobs/types.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { defaultSystemSettings, SettingsStore } from "../src/settings/settings.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import type { ToolContext } from "../src/tools/catalog.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Job lifecycle (doc/design/jobs.md "Lifecycle and retention"): a live job keeps its approval wait when the run
 * ends, stopping a session stops its jobs, the running limit refuses a new job with `job_limit`, and a deleted
 * session's jobs are stopped before they go with the row.
 */
let db: Db;
let cluster: Cluster;
let taskGroups: TaskGroups;
let runtime: AgentRuntime;
let models: ModelConfig;
let store: SettingsStore;
let owner: SessionUser;
let orgId = "";
let root = "";
let storagePath = "";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const openStorage = () => openNodeSqliteStorage(storagePath, { prefix: "pi_" });
const EXEC_SPEC: TaskSpec = { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null };
const EXEC_ACTION = { type: "exec" as const, command: "true" };

beforeEach(async () => {
	db = await openTestDb("sqlite");
	root = await mkdtemp(join(tmpdir(), "crhs-job-lifecycle-"));
	storagePath = join(root, "durable.sqlite");
	const audit = new Audit(db);
	cluster = new Cluster(db, { audit, nodeOfflineGraceMs: 10 });
	taskGroups = new TaskGroups(db, cluster, { audit });
	models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	store = SettingsStore.fromSystemSettings(defaultSystemSettings());
	const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	orgId = await defaultOrgId(db);
	runtime = await AgentRuntime.open({
		callRunner: new CallRunner(),
		db,
		storage: openStorage,
		models,
		cluster,
		taskGroups,
		audit,
		settings: store,
	});
});

afterEach(async () => {
	await runtime.close();
	await cluster.close();
	await taskGroups.close();
	await db.destroy();
	await rm(root, { recursive: true, force: true });
});

const waitFor = async <T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

async function newSession(): Promise<string> {
	return (await runtime.createSession(owner, { model: model(), rulePreset: "yolo" })).id;
}

async function addNode(): Promise<string> {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: orgId,
			name: `node-${id.slice(-8)}`,
			name_key: `node-${id.slice(-8)}`,
			transport: "client",
			status: "active",
			public_key: null,
			hostname: null,
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
			org_id: orgId,
			grantee_type: "user",
			grantee_id: owner.userId,
			target_type: "node",
			target_id: id,
			created_by_user_id: owner.userId,
			created_at: now,
		})
		.execute();
	return id;
}

async function addWaitingTask(
	sessionId: string,
	nodeId: string,
	state: "awaiting_approval" | "awaiting_authorization",
) {
	const id = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("tasks")
		.values({
			id,
			org_id: orgId,
			node_id: nodeId,
			task_group_id: null,
			kind: "exec",
			spec: JSON.stringify(EXEC_SPEC),
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
			error_code: null,
			error_message: null,
			actor_type: "session",
			actor_id: sessionId,
			on_behalf_of_user_id: owner.userId,
			created_at: now,
			dispatched_at: null,
			accepted_at: null,
			finished_at: null,
			output_bytes: 0,
			output_head: null,
			output_tail: null,
			notice: null,
			output_file: null,
			rule_chain: null,
			approval: null,
			pending_input: null,
			root_session_id: null,
			handler_type: state === "awaiting_approval" ? "user" : null,
			handler_session_id: null,
		})
		.execute();
	return id;
}

async function addWaitingCall(
	sessionId: string,
	callKey = newId(),
): Promise<{ job: JobRow; callKey: string; id: string }> {
	const id = externalCallId(callKey);
	const now = new Date().toISOString();
	await db
		.insertInto("external_calls")
		.values({
			id,
			org_id: orgId,
			actor_type: "session",
			actor_id: sessionId,
			on_behalf_of_user_id: owner.userId,
			extension_name: "fake",
			tool_name: "echo",
			arguments: "{}",
			operation: JSON.stringify({ method: "ext.read", target: "fake/echo" }),
			annotations: null,
			rule_chain: null,
			approval: JSON.stringify({ evaluation: { result: "require-approval", levels: [] } }),
			pending_input: null,
			root_session_id: null,
			handler_type: "user",
			handler_session_id: null,
			state: "awaiting_approval",
			created_at: now,
			finished_at: null,
			source_tool_task: null,
			tool_rev: null,
		})
		.execute();
	const job = await runtime.jobs?.ensure({
		kind: "call",
		callKey,
		actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
		sessionId,
		resourceType: "external_call",
		resourceId: id,
		action: { type: "extension_tool", extension: "fake", tool: "echo" },
	});
	if (!job) throw new Error("the job service is missing");
	return { job, callKey, id };
}

async function addExecJob(sessionId: string, taskId: string, callKey = newId()): Promise<JobRow> {
	const job = await runtime.jobs?.ensure({
		kind: "exec",
		callKey,
		actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
		sessionId,
		resourceType: "task",
		resourceId: taskId,
		action: EXEC_ACTION,
	});
	if (!job) throw new Error("the job service is missing");
	return job;
}

const toolResultTexts = async (sessionId: string): Promise<string[]> => {
	const page = await runtime.entriesPage(sessionId, undefined, 100);
	return page.entries.flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			message.role === "toolResult"
				? message.content.flatMap((block) =>
						block.type === "text" && typeof block.text === "string" ? [block.text] : [],
					)
				: [],
		),
	);
};

describe("live jobs hold their waits", () => {
	it("keeps a background job's approval wait when the run that started it ends", async () => {
		const sessionId = await newSession();
		const nodeId = await addNode();
		const heldTask = await addWaitingTask(sessionId, nodeId, "awaiting_approval");
		await addExecJob(sessionId, heldTask, "run-end-held");
		const orphanTask = await addWaitingTask(sessionId, nodeId, "awaiting_approval");

		faux.setResponses([fauxAssistantMessage([fauxText("turn over")])]);
		await runtime.submit(sessionId, owner, "go", "run-end-1");
		await waitFor("the run to end", async () => ((await sessionStateOf(db, sessionId)) === "idle" ? true : undefined));
		// The waiting task behind a live job keeps its approval; one no job holds is ended with the run.
		const held = await cluster.getTask(heldTask);
		expect(held?.state).toBe("awaiting_approval");
		const orphan = await cluster.getTask(orphanTask);
		expect(orphan?.state).toBe("cancelled");
		expect(
			(await runtime.jobs?.get((await runtime.jobs?.forCall("exec", (await jobCallKey(heldTask)) ?? ""))?.id ?? ""))
				?.state,
		).not.toBe("settled");
	});

	async function jobCallKey(taskId: string): Promise<string | undefined> {
		return (await db.selectFrom("jobs").select("call_key").where("resource_id", "=", taskId).executeTakeFirst())
			?.call_key;
	}
});

describe("stopping a session stops its jobs", () => {
	it("cancels task waits and waiting calls through their own paths", async () => {
		const sessionId = await newSession();
		const nodeId = await addNode();
		const taskId = await addWaitingTask(sessionId, nodeId, "awaiting_authorization");
		const taskJob = await addExecJob(sessionId, taskId);
		const call = await addWaitingCall(sessionId);

		await runtime.abort(sessionId);
		expect((await cluster.getTask(taskId))?.state).toBe("cancelled");
		expect(
			(await db.selectFrom("external_calls").select("state").where("id", "=", call.id).executeTakeFirst())?.state,
		).toBe("cancelled");
		const settledTask = await waitFor("the task job to settle", async () => {
			const row = await runtime.jobs?.get(taskJob.id);
			return row?.state === "settled" ? row : undefined;
		});
		expect(settledTask.notice).not.toBe("pending");
		const settledCall = await waitFor("the call job to settle", async () => {
			const row = await runtime.jobs?.get(call.job.id);
			return row?.state === "settled" ? row : undefined;
		});
		expect(JSON.parse(settledCall.outcome ?? "null")).toMatchObject({ kind: "cancelled" });
	});
});

describe("the running-job limit", () => {
	it("counts a session's and an API token's unsettled jobs and lets a replay through", async () => {
		const sessionId = await newSession();
		await store.patch(db, { jobs: { maxRunning: 1 } }, null);
		const call = await addWaitingCall(sessionId);
		const sessionCtx = {
			jobs: runtime.jobs,
			jobsMaxRunning: 1,
			actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
		} as unknown as ToolContext;
		await expect(assertJobLimit(sessionCtx, "exec", "new-call")).rejects.toMatchObject({ code: "job_limit" });
		// The same tool call replayed finds its job and is not refused.
		await expect(assertJobLimit(sessionCtx, "call", call.callKey)).resolves.toBeUndefined();

		const tokenId = newId();
		await runtime.jobs?.ensure({
			kind: "call",
			callKey: "token-call",
			actor: { type: "api_token", id: tokenId, onBehalfOfUserId: owner.userId },
			sessionId: null,
			resourceType: "external_call",
			resourceId: externalCallId("token-call"),
			action: { type: "extension_tool", extension: "fake", tool: "echo" },
		});
		const tokenCtx = {
			jobs: runtime.jobs,
			jobsMaxRunning: 1,
			actor: { type: "api_token", id: tokenId, onBehalfOfUserId: owner.userId },
		} as unknown as ToolContext;
		await expect(assertJobLimit(tokenCtx, "call", "another")).rejects.toMatchObject({ code: "job_limit" });
	});

	it("does not let two parallel exec calls both pass the limit", async () => {
		// `ask` makes the exec wait for approval, so its job stays unsettled while the parallel call checks.
		const sessionId = (await runtime.createSession(owner, { model: model(), rulePreset: "ask" })).id;
		const nodeId = await addNode();
		await store.patch(db, { jobs: { maxRunning: 2 } }, null);
		// One unsettled job: the session is at limit - 1.
		await addWaitingCall(sessionId);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("exec", { cmd: "true", targets: [nodeId], wait: 0 }, { id: "parallel-exec-1" }),
					fauxToolCall("exec", { cmd: "true", targets: [nodeId], wait: 0 }, { id: "parallel-exec-2" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const submission = await runtime.submit(sessionId, owner, "run both", "parallel-limit");
		expect(await runtime.waitForSubmission(submission)).toEqual({ status: "done" });
		const execJobs = await db
			.selectFrom("jobs")
			.selectAll()
			.where("session_id", "=", sessionId)
			.where("kind", "=", "exec")
			.execute();
		expect(execJobs).toHaveLength(1);
		const results = await toolResultTexts(sessionId);
		expect(results.filter((text) => text.includes("jobs.max_running is 2"))).toHaveLength(1);
	});

	it("refuses a `subagent` tool call at the limit before creating the child", async () => {
		const sessionId = await newSession();
		await store.patch(db, { jobs: { maxRunning: 1 } }, null);
		await addWaitingCall(sessionId);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { task: "should not start" }, { id: "limit-subagent" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("understood")]),
		]);
		const submission = await runtime.submit(sessionId, owner, "start it", "limit-1");
		expect(await runtime.waitForSubmission(submission)).toEqual({ status: "done" });
		const results = await toolResultTexts(sessionId);
		expect(results.some((text) => text.includes("job_limit") && text.includes("jobs.max_running is 1"))).toBe(true);
		const children = await db.selectFrom("sessions").select("id").where("parent_session_id", "=", sessionId).execute();
		expect(children).toHaveLength(0);
	});
});

describe("session deletion", () => {
	it("stops the session's jobs and deletes them with the row", async () => {
		const sessionId = await newSession();
		const call = await addWaitingCall(sessionId);
		await runtime.jobs?.cancelSessionJobs(sessionId);
		expect(
			(await db.selectFrom("external_calls").select("state").where("id", "=", call.id).executeTakeFirst())?.state,
		).toBe("cancelled");
		expect((await runtime.jobs?.get(call.job.id))?.state).toBe("settled");
		await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
		expect(await db.selectFrom("jobs").select("id").where("session_id", "=", sessionId).execute()).toHaveLength(0);
	});
});

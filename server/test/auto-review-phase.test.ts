import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DEFAULT_LLM_TIMEOUTS } from "../src/agent/llm-timeout.ts";
import { ModelPresets } from "../src/agent/model-presets.ts";
import { ModelConfig } from "../src/agent/models.ts";
import { Reviewer } from "../src/agent/review.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { isPendingReview } from "../src/cluster/approval.ts";
import { Cluster, type TaskView } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Auto Review's reviewing phase (doc/design/access-control.md "Auto Review"): while the reviewer decides, the
 * request looks like a running tool call - the session stays running, no approval list or chat notification
 * shows it, and a decision is refused. Escalation (here a stalled reviewer timing out) makes it visible and
 * moves the session to waiting.
 */

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

let db: Db;
let app: App;
let runtime: AgentRuntime;
let cluster: Cluster;
let groups: TaskGroups;
let audit: Audit;
let models: ModelConfig;
let owner: SessionUser;
let cookie: string;
let nodeId = "";

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	cluster = new Cluster(db, { audit, nodeOfflineGraceMs: 10 });
	groups = new TaskGroups(db, cluster, { audit });
	models = new ModelConfig(db, MasterKey.generate());
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
	app = makeApp(db, undefined, { cluster, taskGroups: groups, audit });
	const user = await createUser(db, { username: "phase-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	cookie = await login(app, "phase-owner", "password-123");
	nodeId = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id: nodeId,
			org_id: await defaultOrgId(db),
			name: "phase-1",
			name_key: "phase-1",
			transport: "client",
			status: "active",
			public_key: null,
			hostname: "phase-1",
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
			grantee_id: user.id,
			target_type: "node",
			target_id: nodeId,
			created_by_user_id: user.id,
			created_at: now,
		})
		.execute();
});

afterAll(async () => {
	models.llmTimeouts = { ...DEFAULT_LLM_TIMEOUTS };
	await runtime.close();
	cluster.endWaits();
	groups.endWaits();
	await cluster.close();
	await groups.close();
	await db.destroy();
});

const pendingTask = async (sessionId: string) =>
	waitFor("the waiting task", async () => {
		const row = await db
			.selectFrom("tasks")
			.select("id")
			.where("actor_id", "=", sessionId)
			.where("state", "=", "awaiting_approval")
			.executeTakeFirst();
		return row?.id;
	});

const taskView = async (id: string) => (await cluster.getTask(id)) as TaskView;

it("hides a request while Auto Review runs, then escalates it when the reviewer times out", async () => {
	models.llmTimeouts = { idleMs: 300, overallMs: 5_000 };
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "auto_review",
		title: "reviewing phase",
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("exec", { targets: ["phase-1"], cmd: "true" }, { id: "phase-tool" })], {
			stopReason: "toolUse",
		}),
		(_context: unknown, options?: { signal?: AbortSignal }) =>
			new Promise<AssistantMessage>((_resolve, reject) => {
				// The timeout aborts the stream; rejecting lets the faux provider finish cleanly.
				options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			}),
	]);
	const submission = await runtime.submit(session.id, owner, "run it", "phase-review-1");
	const taskId = await pendingTask(session.id);
	// The review marker is written with the row, and the review is running now.
	await waitFor("the pending review", async () => {
		const view = await taskView(taskId);
		return isPendingReview(view.approval?.review) ? true : undefined;
	});
	expect(await sessionStateOf(db, session.id)).toBe("running");
	const reviewing = await taskView(taskId);
	expect(reviewing.phase).toBe("reviewing");

	// Not a pending approval: the approvals list leaves it out and a decision is refused.
	const listed = (await (await call(app, "/api/approvals", { cookie })).json()) as { tasks: TaskView[] };
	expect(listed.tasks.map((task) => task.id)).not.toContain(taskId);
	const detail = (await (await call(app, `/api/tasks/${taskId}`, { cookie })).json()) as { task: TaskView };
	expect(detail.task.phase).toBe("reviewing");
	const refused = await call(app, `/api/tasks/${taskId}/approval`, {
		cookie,
		body: { decision: "approve" },
	});
	expect(refused.status).toBe(409);
	expect(((await refused.json()) as { error: string }).error).toContain("Auto Review is still reviewing");

	// The stalled review times out and escalates: it becomes a user-facing approval and the session waits.
	const escalated = await waitFor("the escalated approval", async () => {
		const view = await taskView(taskId);
		const review = view.approval?.review;
		return review && !isPendingReview(review) ? view : undefined;
	});
	expect(escalated.phase).toBe("awaiting_user");
	expect(escalated.approval?.review).toMatchObject({ decision: "escalate", reason: "Auto Review timed out" });
	await waitFor("the session awaiting approval", async () => {
		const row = await db
			.selectFrom("sessions")
			.select(["state", "waiting_kind"])
			.where("id", "=", session.id)
			.executeTakeFirst();
		return row?.state === "awaiting" && row.waiting_kind === "approval" ? true : undefined;
	});
	const visible = (await (await call(app, "/api/approvals", { cookie })).json()) as { tasks: TaskView[] };
	expect(visible.tasks.map((task) => task.id)).toContain(taskId);

	await cluster.decide(taskId, {
		decision: "rejected",
		by: { type: "user", id: owner.userId, onBehalfOfUserId: owner.userId },
		at: new Date().toISOString(),
	});
	await runtime.abort(session.id, owner);
	await waitSubmission(runtime, session.id, submission);
});

it("escalates a request whose review fails outside the model call, instead of leaving it reviewing", async () => {
	models.llmTimeouts = { idleMs: 60_000, overallMs: 60_000 };
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "auto_review",
		title: "failing review",
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("exec", { targets: ["phase-1"], cmd: "true" }, { id: "fail-tool" })], {
			stopReason: "toolUse",
		}),
		// The runtime's own review hangs until the turn is stopped, so only the review below settles the task.
		(_context: unknown, options?: { signal?: AbortSignal }) =>
			new Promise<AssistantMessage>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			}),
	]);
	const submission = await runtime.submit(session.id, owner, "run it", "phase-review-fail");
	const taskId = await pendingTask(session.id);
	await waitFor("the pending review", async () => {
		const view = await taskView(taskId);
		return isPendingReview(view.approval?.review) ? true : undefined;
	});
	const presets = new ModelPresets(db);
	await presets.load();
	const reviewer = new Reviewer(db, models, cluster, groups, presets, {
		history: async () => {
			throw new Error("history unavailable");
		},
		toolCalls: async () => [],
		builtinToolDescription: async () => null,
		toolDescription: async () => null,
	});
	await reviewer.reviewTask(await taskView(taskId));
	const settled = await taskView(taskId);
	expect(settled.phase).toBe("awaiting_user");
	expect(settled.approval?.review).toMatchObject({
		decision: "escalate",
		reason: "review failed: history unavailable",
	});

	await cluster.decide(taskId, {
		decision: "rejected",
		by: { type: "user", id: owner.userId, onBehalfOfUserId: owner.userId },
		at: new Date().toISOString(),
	});
	await runtime.abort(session.id, owner);
	await waitSubmission(runtime, session.id, submission);
});

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type ConversationId,
	type EntryId,
	MemoryStorage,
	type StorageWrite,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { isPendingReview, pendingReview } from "../src/cluster/approval.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { createExternalCall, externalCallId, getExternalCall } from "../src/extensions/external-calls.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Reviews a restart interrupted run again (doc/design/access-control.md "Auto Review"): the pending marker is
 * durable while the review call is not, so startup (and a reopened runtime) judges tasks, task groups and
 * external calls with it once more. The reviewer's single-flight keeps a replayed tool call from doubling it.
 */

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
const ESCALATE = fauxAssistantMessage([
	fauxToolCall("submit_review", { decision: "escalate", risk: "high", reason: "judge it again" }),
]);

let db: Db;
let runtime: AgentRuntime;
let cluster: Cluster;
let groups: TaskGroups;
let audit: Audit;
let storage: MemoryStorage;
let owner: SessionUser;
let sessionId = "";
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
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	storage = new MemoryStorage();
	runtime = await AgentRuntime.open({
		db,
		storage,
		models,
		cluster,
		taskGroups: groups,
		audit,
	});
	const user = await createUser(db, { username: "resume-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	sessionId = (await runtime.createSession(owner, { model: model(), rulePreset: "auto_review", title: "resume" })).id;
	nodeId = newId();
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id: nodeId,
			org_id: await defaultOrgId(db),
			name: "resume-1",
			name_key: "resume-1",
			transport: "client",
			status: "active",
			public_key: null,
			hostname: "resume-1",
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
	await runtime.close();
	cluster.endWaits();
	groups.endWaits();
	await cluster.close();
	await groups.close();
	await db.destroy();
});

const chain = () => [{ type: "session" as const, id: sessionId }];

/** Records the assistant entry and the terminal pi.tool task of one call the reviewer can read. */
async function recordToolCall(name: string, args: Record<string, unknown>, callId: string): Promise<string> {
	const row = await db
		.selectFrom("sessions")
		.select("conversation_id")
		.where("id", "=", sessionId)
		.executeTakeFirstOrThrow();
	const conversationId = Number(row.conversation_id) as ConversationId;
	const entryId = await storage.mintId<EntryId>();
	const toolTaskId = await storage.mintId<TaskId>();
	await storage.commit(
		[
			{
				type: "entry",
				value: {
					id: entryId,
					conversationId,
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: callId, name, arguments: args }],
							timestamp: Date.now(),
						},
					],
				},
			},
			{
				type: "task",
				value: {
					id: toolTaskId,
					conversationId,
					kind: "pi.tool",
					version: 1,
					input: { kind: "model", assistant: entryId, callId },
					background: false,
					abortRequested: false,
					state: { status: "terminal", outcome: { status: "completed", result: { kind: "model", entryId } } },
				},
			},
		] as unknown as StorageWrite[],
		BACKGROUND_CONTEXT,
	);
	return String(toolTaskId);
}

it("re-reviews a task, a task group and an external call left pending by a restart", async () => {
	const taskCall = await recordToolCall("exec", { targets: [nodeId], cmd: "true" }, "call-0");
	const savedTaskHook = cluster.onAwaitingApproval;
	cluster.onAwaitingApproval = undefined;
	const task = await cluster.createTask({
		nodeId,
		spec: { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null },
		sourceToolTask: taskCall,
		chain: chain(),
		actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
	});
	cluster.onAwaitingApproval = savedTaskHook;
	expect(isPendingReview(task.approval?.review)).toBe(true);

	const groupCall = await recordToolCall("exec", { targets: [nodeId], cmd: "true" }, "call-0");
	const savedGroupHook = groups.onAwaitingApproval;
	groups.onAwaitingApproval = undefined;
	const groupId = await groups.create({
		targets: [nodeId],
		nodeIds: [nodeId],
		spec: { kind: "exec", command: { argv: ["true"] }, env: {}, cwd: "", stdin: null },
		sourceToolTask: groupCall,
		chain: chain(),
		actor: { type: "session", id: sessionId, onBehalfOfUserId: owner.userId },
	});
	groups.onAwaitingApproval = savedGroupHook;
	const group = await groups.get(groupId);
	expect(isPendingReview(group?.approval?.review)).toBe(true);

	const externalCall = await recordToolCall("ext__test__echo", { message: "hi" }, "call-0");
	const callKey = "resume-call";
	const { row: call } = await createExternalCall(db, {
		callKey,
		orgId: await defaultOrgId(db),
		actorType: "session",
		actorId: sessionId,
		onBehalfOfUserId: owner.userId,
		extension: "test",
		tool: "echo",
		arguments: {},
		operation: { method: "ext.write", target: "test/echo" },
		annotations: null,
		ruleChain: chain(),
		rootSessionId: sessionId,
		sourceToolTask: externalCall,
		approval: {
			evaluation: { result: "require-approval", levels: [] },
			review: pendingReview(new Date().toISOString()),
		},
		state: "awaiting_approval",
	});

	faux.setResponses([ESCALATE, ESCALATE, ESCALATE]);
	// Two restarts (or a replay racing the sweep) must not judge the same request twice.
	await Promise.all([runtime.resumePendingReviews(), runtime.resumePendingReviews()]);

	await waitFor("the task review", async () => {
		const view = await cluster.getTask(task.id);
		const review = view?.approval?.review;
		return review && !isPendingReview(review) ? review : undefined;
	});
	await waitFor("the group review", async () => {
		const view = await groups.get(groupId);
		const review = view?.approval?.review;
		return review && !isPendingReview(review) ? review : undefined;
	});
	await waitFor("the call review", async () => {
		const current = await getExternalCall(db, externalCallId(callKey));
		const review = current ? JSON.parse(current.approval ?? "{}").review : undefined;
		return review && !isPendingReview(review) ? review : undefined;
	});
	const reviewedCall = await getExternalCall(db, externalCallId(callKey));
	expect(reviewedCall?.state).toBe("awaiting_approval");
	expect(JSON.parse(reviewedCall?.approval ?? "{}").review).toMatchObject({
		decision: "escalate",
		reason: "judge it again",
	});

	await audit.flush();
	const events = await db
		.selectFrom("audit_events")
		.select(["action", "target_id"])
		.where("action", "=", "external_call.review")
		.where("target_id", "=", call.id)
		.execute();
	expect(events).toHaveLength(1);
	expect(faux.getPendingResponseCount()).toBe(0);

	// Cleanup: the escalated requests are user-facing now.
	const rejected = {
		decision: "rejected" as const,
		by: { type: "user" as const, id: owner.userId, onBehalfOfUserId: owner.userId },
		at: new Date().toISOString(),
	};
	await cluster.decide(task.id, rejected);
	await groups.decide(groupId, rejected);
	await db
		.updateTable("external_calls")
		.set({ state: "rejected", arguments: null, finished_at: new Date().toISOString() })
		.where("id", "=", call.id)
		.execute();
});

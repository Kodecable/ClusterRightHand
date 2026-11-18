import type { TaskSpec } from "@crh/protocol";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { budgetUsedTokens, contextTokens, usageTokens } from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { createRootRuleSet } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { createUser } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Auto Review is a model call: its output is charged to the session that owns the reviewed task. API
 * tokens never use Auto Review, so a token root cannot spend a session's quota.
 */
let db: Db;
let cluster: Cluster;
let runtime: AgentRuntime;
let owner: SessionUser;
let nodeId = "";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });
// The reviewer answers with one line of JSON; the faux provider reports that text's output tokens.
const ANSWER = '{"decision":"escalate","reason":"check it"}';

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
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
			name: "review-node",
			name_key: "review-node",
			transport: "client",
			status: "active",
			public_key: null,
			hostname: "review-node",
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
	await cluster.close();
	await db.destroy();
});

const spec: TaskSpec = { kind: "exec", command: { argv: ["echo", "hi"] }, env: {}, cwd: "", stdin: null };

it("charges an Auto Review answer to the reviewed session and its chain", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "auto_review",
		title: "reviewed",
		budgetRemaining: 1_000_000,
	});
	// The reviewed task must come from a real tool call: Auto Review reads the durable tool task that call
	// recorded (source_tool_task), and a task created directly is escalated without asking the model.
	let beforeReview: { budget: number; usage: number; context: number | null; remaining: number | null } | undefined;
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("exec", { targets: ["review-node"], cmd: "echo hi", wait: 0 }, { id: "quota-call" })],
			{ stopReason: "toolUse" },
		),
		async () => {
			// The main turn that issued the tool call has already been charged; the review's charge lands only
			// after this answer is returned (the exec tool blocks while the task waits for approval).
			beforeReview = {
				budget: await budgetUsedTokens(db, session.id),
				usage: await usageTokens(db, session.id),
				context: await contextTokens(db, session.id),
				remaining: (await runtime.getSession(session.id))?.budgetRemaining ?? null,
			};
			return fauxAssistantMessage([fauxText(ANSWER)]);
		},
	]);
	const submission = await runtime.submit(session.id, owner, "run the command", "review-quota-call");
	const task = await waitFor("the task created by the tool call", async () => {
		const row = await db
			.selectFrom("tasks")
			.select(["id", "source_tool_task"])
			.where("actor_id", "=", session.id)
			.executeTakeFirst();
		return row ? row : undefined;
	});
	expect(task.source_tool_task).not.toBeNull();
	const reviewed = await waitFor("the review verdict", async () => {
		const view = await cluster.getTask(task.id);
		const review = view?.approval?.review as { decision?: string } | null | undefined;
		return review?.decision ? view : undefined;
	});
	const afterReview = {
		budget: await budgetUsedTokens(db, session.id),
		usage: await usageTokens(db, session.id),
		context: await contextTokens(db, session.id),
		remaining: (await runtime.getSession(session.id))?.budgetRemaining ?? null,
	};
	if (!beforeReview) throw new Error("the review never started");
	const tokens = Math.ceil(ANSWER.length / 4);
	// Only the review's output grew the budget and spent the quota while the main turn waited for the approval.
	expect(afterReview.budget - beforeReview.budget).toBe(tokens);
	expect(afterReview.remaining).toBe((beforeReview.remaining ?? 0) - tokens);
	// The review's request counts in the usage measure too, and a review never moves the context fill.
	expect(afterReview.usage - beforeReview.usage).toBeGreaterThan(tokens);
	expect(afterReview.context).toBe(beforeReview.context);
	expect(afterReview.context).not.toBeNull();
	expect(reviewed.approval?.review).toMatchObject({
		decision: "escalate",
		model: `${faux.provider.id}/${faux.getModel().id}`,
	});
	await runtime.abort(session.id, owner);
	await waitSubmission(runtime, session.id, submission);
});

it("does not review a task whose root is an API token", async () => {
	// An API token root has no user instructions for the reviewer, so it never gets an Auto Review even if the
	// stored rule set says auto_review (the migration moves those to ask).
	const tokenId = newId();
	await createRootRuleSet(db, await defaultOrgId(db), { type: "api_token", id: tokenId }, "auto_review");
	await runtime.modelPresets.update("review", { model: model() });
	const other = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "unrelated" });
	const before = await db.selectFrom("sessions").select(["id", "budget_used_tokens", "usage_tokens"]).execute();
	faux.setResponses([fauxAssistantMessage([fauxText(ANSWER)])]);
	const task = await cluster.createTask({
		nodeId,
		spec,
		chain: [{ type: "api_token", id: tokenId }],
		actor: { type: "api_token", id: tokenId, onBehalfOfUserId: owner.userId },
	});
	// The awaiting hook is detached from createTask, so give it a moment to find nothing to review.
	await new Promise((resolve) => setTimeout(resolve, 200));
	const view = await cluster.getTask(task.id);
	expect(view?.state).toBe("awaiting_approval");
	expect(view?.approval?.review).toBeUndefined();
	// The reviewer never ran: its prepared answer is still pending.
	expect(faux.getPendingResponseCount()).toBe(1);
	expect(await budgetUsedTokens(db, other.id)).toBe(0);
	const after = await db.selectFrom("sessions").select(["id", "budget_used_tokens", "usage_tokens"]).execute();
	expect(after).toEqual(before);
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

import type { TaskSpec } from "@crh/protocol";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { spentTokens } from "../src/agent/quota.ts";
import { setReviewModel } from "../src/agent/review.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { createRootRuleSet } from "../src/policy/store.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, defaultOrgId } from "../src/users/service.ts";
import { newId } from "../src/util/id.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Auto Review is a model call: its output is charged to the session that owns the reviewed task (D92). A task
 * whose root is not a session (an API token) is not charged anywhere.
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
			name: "review-node",
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
			ssh_host_key: null,
			ssh_credential_id: null,
			ssh_jumps: null,
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
		preset: "auto_review",
		title: "reviewed",
		quota: 1_000_000,
	});
	faux.setResponses([fauxAssistantMessage([fauxText(ANSWER)])]);
	const task = await cluster.createTask({
		nodeId,
		spec,
		chain: [{ type: "session", id: session.id }],
		actor: { type: "session", id: session.id, onBehalfOfUserId: owner.userId },
	});
	const charged = await waitFor("the review's charge", async () => {
		const used = await spentTokens(db, session.id);
		return used > 0 ? used : undefined;
	});
	const tokens = Math.ceil(ANSWER.length / 4);
	expect(charged).toBe(tokens);
	expect((await runtime.getSession(session.id))?.quota).toBe(1_000_000 - tokens);
	const reviewed = await cluster.getTask(task.id);
	expect(reviewed?.approval?.review).toMatchObject({
		decision: "escalate",
		model: `${faux.provider.id}/${faux.getModel().id}`,
	});
});

it("does not charge a review when the root is not a session", async () => {
	// An API token root has no session to charge: the review runs (a configured review model), but nothing is spent.
	const tokenId = newId();
	await createRootRuleSet(db, await defaultOrgId(db), { type: "api_token", id: tokenId }, "auto_review");
	await setReviewModel(db, model());
	const other = await runtime.createSession(owner, { model: model(), preset: "yolo", title: "unrelated" });
	const before = await db.selectFrom("sessions").select(["id", "used_tokens"]).execute();
	faux.setResponses([fauxAssistantMessage([fauxText(ANSWER)])]);
	const task = await cluster.createTask({
		nodeId,
		spec,
		chain: [{ type: "api_token", id: tokenId }],
		actor: { type: "api_token", id: tokenId, onBehalfOfUserId: owner.userId },
	});
	const reviewed = await waitFor("the API token review", async () => {
		const view = await cluster.getTask(task.id);
		return view?.approval?.review ? view : undefined;
	});
	expect(reviewed.approval?.review?.decision).toBe("escalate");
	expect(await spentTokens(db, other.id)).toBe(0);
	// No session was charged by the review: only the earlier test's session carries its own spend.
	const after = await db.selectFrom("sessions").select(["id", "used_tokens"]).execute();
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

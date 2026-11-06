import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import {
	awaitingQuotaChildren,
	budgetUsedTokens,
	chargeCall,
	exhaustedLevel,
	parseQuota,
	setQuota,
} from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { sessionStateOf } from "../src/agent/session-state.ts";
import { accountedOutputTokens } from "../src/agent/tokens.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { openDb } from "../src/storage/db.ts";
import { migrateToLatest } from "../src/storage/migrate.ts";
import { backfillHandlers } from "../src/storage/migrations/0018_approval_handler.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";
import { waitSubmission } from "./helpers/runtime.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Unified quotas (D92): any level may have one, every model call charges every level that has one (the root
 * included), and an exhausted level asks its direct parent only; a root asks its owner (D77).
 */
let db: Db;
let runtime: AgentRuntime;
let owner: SessionUser;
let app: App;
let ownerCookie = "";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const masterKey = MasterKey.generate();
	const models = new ModelConfig(db, masterKey);
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
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	ownerCookie = await login(app, "owner", "password-123");
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

const root = (title = "root") => runtime.createSession(owner, { model: model(), rulePreset: "yolo", title });
const child = (parentId: string, key: string, quota: number | null, rules = { default: "inherit", rules: [] }) =>
	runtime.createSubagent(parentId, { callKey: key, task: `task ${key}`, rules: rules as never, quota });

it("accepts a non-negative integer quota or null", () => {
	expect(parseQuota(0)).toBe(0);
	expect(parseQuota(12_345)).toBe(12_345);
	expect(parseQuota(null)).toBeNull();
	for (const bad of [-1, 1.5, "100", undefined, Number.NaN]) expect(() => parseQuota(bad)).toThrow();
});

it("a root session without a quota is unlimited and is never charged", async () => {
	const r = await root();
	expect((await runtime.getSession(r.id))?.budgetRemaining).toBeNull();
	await chargeCall(db, r.id, { budget: 500, usage: 500, context: 0 });
	expect((await runtime.getSession(r.id))?.budgetRemaining).toBeNull();
	expect(await budgetUsedTokens(db, r.id)).toBe(500);
	expect(await exhaustedLevel(db, r.id)).toBeUndefined();
});

it("each model call charges every level of the chain that has a quota, not the unlimited ones", async () => {
	const r = await root();
	const p = await child(r.id, "chain-p", 1_000);
	const c = await child(p.id, "chain-c", 500);
	await chargeCall(db, c.id, { budget: 600, usage: 600, context: 0 });
	expect((await runtime.getSession(c.id))?.budgetRemaining).toBe(-100);
	expect((await runtime.getSession(p.id))?.budgetRemaining).toBe(400);
	expect((await runtime.getSession(r.id))?.budgetRemaining).toBeNull();
	expect(await exhaustedLevel(db, c.id)).toBe(c.id);
	await chargeCall(db, c.id, { budget: 500, usage: 500, context: 0 });
	expect(await exhaustedLevel(db, c.id)).toBe(p.id);
	expect((await runtime.getSession(p.id))?.budgetRemaining).toBe(-100);
	expect(await budgetUsedTokens(db, r.id)).toBe(1_100);
});

it("a root with a quota is charged like any other level", async () => {
	const r = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "yolo",
		title: "charged root",
		budgetRemaining: 1_000,
	});
	const c = await child(r.id, "charged-root-c", 500);
	await chargeCall(db, c.id, { budget: 600, usage: 600, context: 0 });
	expect((await runtime.getSession(r.id))?.budgetRemaining).toBe(400);
	expect((await runtime.getSession(c.id))?.budgetRemaining).toBe(-100);
	expect(await exhaustedLevel(db, c.id)).toBe(c.id);
	await chargeCall(db, c.id, { budget: 500, usage: 500, context: 0 });
	expect((await runtime.getSession(r.id))?.budgetRemaining).toBe(-100);
	// The root is exhausted first: it is the highest level of the chain.
	expect(await exhaustedLevel(db, c.id)).toBe(r.id);
	expect(await budgetUsedTokens(db, r.id)).toBe(1_100);
});

it("accountedOutputTokens uses the reported output, then estimates 0.3 × UTF-8 bytes", () => {
	// Reported output wins, reasoning included; input and cache do not count.
	expect(accountedOutputTokens({ usage: { output: 42 }, content: [{ type: "text", text: "x".repeat(1_000) }] })).toBe(
		42,
	);
	expect(accountedOutputTokens({ usage: { output: 0 }, content: [] })).toBe(0);
	// Text: ceil(bytes × 0.3), with multi-byte characters counted as bytes.
	expect(accountedOutputTokens({ content: [{ type: "text", text: "abcd" }] })).toBe(2);
	expect(accountedOutputTokens({ usage: { output: 0 }, content: [{ type: "text", text: "é" }] })).toBe(1);
	// Thinking is visible output too.
	expect(accountedOutputTokens({ content: [{ type: "thinking", thinking: "1234567890" }] })).toBe(3);
	// Tool calls: the name and the JSON-serialized arguments.
	expect(accountedOutputTokens({ content: [{ type: "toolCall", name: "exec", arguments: { cmd: "true" } }] })).toBe(6);
	expect(
		accountedOutputTokens({
			content: [
				{ type: "text", text: "abcd" },
				{ type: "thinking", thinking: "12345" },
				{ type: "toolCall", name: "exec", arguments: {} },
			],
		}),
	).toBe(5);
});

it("setting a subagent's quota replaces the remaining amount", async () => {
	const r = await root();
	const c = await child(r.id, "replace", 100);
	await chargeCall(db, c.id, { budget: 250, usage: 250, context: 0 });
	expect((await runtime.getSession(c.id))?.budgetRemaining).toBe(-150);
	expect(await exhaustedLevel(db, c.id)).toBe(c.id);
	await setQuota(db, c.id, 100);
	expect(await exhaustedLevel(db, c.id)).toBeUndefined();
	await setQuota(db, c.id, 0);
	expect(await exhaustedLevel(db, c.id)).toBe(c.id);
});

it("a paused child asks its direct parent, which grants without a cap", async () => {
	const r = await root();
	const p = await child(r.id, "pause-p", 10_000_000);
	const c = await child(p.id, "pause-c", 10);
	await chargeCall(db, c.id, { budget: 20, usage: 20, context: 0 });
	const waiting = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
	const request = await waitFor("the quota wait", async () => (await awaitingQuotaChildren(db, p.id))[0]);
	expect(request).toMatchObject({ sessionId: c.id, levelId: c.id });
	expect(await sessionStateOf(db, c.id)).toBe("awaiting");
	const waitingRow = await db
		.selectFrom("sessions")
		.select(["waiting_level_id", "waiting_handler_id"])
		.where("id", "=", c.id)
		.executeTakeFirstOrThrow();
	expect(waitingRow).toMatchObject({ waiting_level_id: c.id, waiting_handler_id: p.id });
	await db.updateTable("sessions").set({ waiting_handler_id: null }).where("id", "=", c.id).execute();
	await backfillHandlers(db);
	expect(await sessionStateOf(db, c.id)).toBe("awaiting");
	const restored = await db
		.selectFrom("sessions")
		.select("waiting_handler_id")
		.where("id", "=", c.id)
		.executeTakeFirstOrThrow();
	expect(restored.waiting_handler_id).toBe(p.id);
	// No cap: the parent's own remainder does not limit what it adds for its child.
	expect(await runtime.decideAgentRequest(p.id, request.sessionId, "approve", undefined, 50_000_000)).toBe("quota");
	expect(await waiting).toBe("ok");
	expect(await sessionStateOf(db, c.id)).toBe("running");
	const resumed = await db
		.selectFrom("sessions")
		.select(["waiting_kind", "waiting_level_id", "waiting_handler_id"])
		.where("id", "=", c.id)
		.executeTakeFirstOrThrow();
	expect(resumed).toMatchObject({ waiting_kind: null, waiting_level_id: null, waiting_handler_id: null });
	expect((await runtime.getSession(c.id))?.budgetRemaining).toBe(50_000_000 - 10);
});

it("drops a quota request as soon as its level is restored", async () => {
	const r = await root();
	const p = await child(r.id, "restored-p", null);
	const c = await child(p.id, "restored-c", 10);
	await chargeCall(db, c.id, { budget: 20, usage: 20, context: 0 });
	const waiting = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
	await waitFor("the pause", async () => (await awaitingQuotaChildren(db, p.id))[0]);
	// Restore the level directly; the cached request must not survive the state write.
	await setQuota(db, c.id, 1_000);
	expect(await awaitingQuotaChildren(db, p.id)).toEqual([]);
	expect(await runtime.decideAgentRequest(p.id, c.id, "approve", undefined, 1_000)).toBe("quota");
	expect(await waiting).toBe("ok");
});

it("a finished subagent is idle until the next input", async () => {
	const r = await root();
	const c = await child(r.id, "done-child", null);
	faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
	await runtime.startSubagent(c.id, "work", "sub-1");
	expect(await runtime.waitSubagent(c.id)).toEqual({ status: "done", answer: "done" });
	await waitFor("idle", async () => ((await sessionStateOf(db, c.id)) === "idle" ? true : undefined));
});

it("a denied request ends the paused run and leaves the session idle", async () => {
	const r = await root();
	const p = await child(r.id, "deny-p", 10_000_000);
	const c = await child(p.id, "deny-c", 10);
	await chargeCall(db, c.id, { budget: 20, usage: 20, context: 0 });
	const waiting = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
	const request = await waitFor("the quota wait", async () => (await awaitingQuotaChildren(db, p.id))[0]);
	expect(await runtime.decideAgentRequest(p.id, request.sessionId, "deny")).toBe("quota");
	expect(await waiting).toBe("denied");
	expect(await sessionStateOf(db, c.id)).toBe("idle");
});

it("a denial ends a run that is still paused in waitForQuota", async () => {
	const r = await root();
	const p = await child(r.id, "live-deny-p", null);
	const c = await child(p.id, "live-deny-c", 10);
	await chargeCall(db, c.id, { budget: 20, usage: 20, context: 0 });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("exec", { targets: ["missing"], cmd: "true" }, { id: "q1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("noted")]),
	]);
	await runtime.startSubagent(c.id, "work", "live-deny-submit");
	try {
		const request = await waitFor("the live quota wait", async () => (await awaitingQuotaChildren(db, p.id))[0]);
		expect(await sessionStateOf(db, c.id)).toBe("awaiting");
		expect(await runtime.decideAgentRequest(p.id, request.sessionId, "deny")).toBe("quota");
		// The run is still live while its tool call ends; a read must not turn the end back into a wait.
		expect(await runtime.refreshState(c.id)).toBe("idle");
		expect(await sessionStateOf(db, c.id)).toBe("idle");
		const result = await Promise.race([
			runtime.waitSubagent(c.id),
			new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 2000)),
		]);
		expect(result).not.toBe("still-waiting");
		expect(await sessionStateOf(db, c.id)).toBe("idle");
	} finally {
		await runtime.abort(c.id).catch(() => {});
	}
});

it("a second pause on the same level wakes the parent again", async () => {
	const r = await root();
	const p = await child(r.id, "again-p", null);
	const c = await child(p.id, "again-c", 10);
	let seen = "";
	const stop = await runtime.watch(p.id, (events) => {
		seen += JSON.stringify(events);
	});
	try {
		faux.setResponses([fauxAssistantMessage([fauxText("wake one")]), fauxAssistantMessage([fauxText("wake two")])]);
		await chargeCall(db, c.id, { budget: 20, usage: 20, context: 0 });
		const first = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
		await waitFor("the first pause", async () => (await awaitingQuotaChildren(db, p.id))[0]);
		await waitFor("the first wake", async () =>
			(seen.match(/token quota is used up/g)?.length ?? 0) >= 1 ? true : undefined,
		);
		expect(await runtime.decideAgentRequest(p.id, c.id, "approve", undefined, 20)).toBe("quota");
		expect(await first).toBe("ok");
		expect(await sessionStateOf(db, c.id)).toBe("running");

		// The same level runs out again: this is a new pause, so the parent must hear about it again.
		await chargeCall(db, c.id, { budget: 20, usage: 20, context: 0 });
		const second = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
		await waitFor("the second pause", async () => (await awaitingQuotaChildren(db, p.id))[0]);
		await waitFor("the second wake", async () =>
			(seen.match(/token quota is used up/g)?.length ?? 0) >= 2 ? true : undefined,
		);
		expect(await runtime.decideAgentRequest(p.id, c.id, "approve", undefined, 1_000)).toBe("quota");
		expect(await second).toBe("ok");
	} finally {
		stop();
	}
});

it("flushes a quota wake when a running parent becomes idle", async () => {
	const r = await root();
	const p = await child(r.id, "idle-flush-p", null);
	const c = await child(p.id, "idle-flush-c", 10);
	await chargeCall(db, c.id, { budget: 20, usage: 20, context: 0 });
	let parentStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		parentStarted = resolve;
	});
	faux.setResponses([
		async () => {
			parentStarted();
			await new Promise((resolve) => setTimeout(resolve, 300));
			return fauxAssistantMessage([fauxText("parent done")]);
		},
		fauxAssistantMessage([fauxToolCall("exec", { targets: ["missing"], cmd: "true" }, { id: "idle-q1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("wake handled")]),
	]);
	let seen = "";
	const stop = await runtime.watch(p.id, (events) => {
		seen += JSON.stringify(events);
	});
	try {
		const first = await runtime.submit(p.id, owner, "be busy for a moment", "idle-flush-parent");
		await started;
		// The parent is live; the quota request must be queued, not dropped, and delivered when the run ends.
		await runtime.startSubagent(c.id, "work", "idle-flush-child");
		await waitFor("the flushed wake", async () => (seen.includes("token quota is used up") ? true : undefined));
		expect(faux.getPendingResponseCount()).toBe(0);
		// The wake is a new input: it becomes the last submission, and its run ends as idle.
		await waitFor("the parent idle", async () => ((await sessionStateOf(db, p.id)) === "idle" ? true : undefined));
		const parentRow = await db
			.selectFrom("sessions")
			.select("last_submission_id")
			.where("id", "=", p.id)
			.executeTakeFirstOrThrow();
		expect(parentRow.last_submission_id).not.toBe(first);
		expect(await runtime.waitSubagent(p.id, { attention: false })).toEqual({ status: "done", answer: "wake handled" });
		expect(await runtime.decideAgentRequest(p.id, c.id, "approve", undefined, 1_000)).toBe("quota");
	} finally {
		stop();
		await runtime.abort(r.id).catch(() => {});
	}
});

it("subagent_wait watches the caller's inbox, not the waited session's parent", async () => {
	const r = await root();
	const a = await child(r.id, "grand-parent", 0);
	const b = await child(a.id, "grand-child", 100);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("exec", { targets: ["missing"], cmd: "true" }, { id: "grand-q1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("noted")]),
	]);
	try {
		await runtime.startSubagent(b.id, "work", "grand-wait");
		const request = await waitFor("the root's quota request", async () => (await awaitingQuotaChildren(db, r.id))[0]);
		expect(request).toMatchObject({ sessionId: b.id, levelId: a.id });
		const result = await runtime.waitSubagent(b.id, { attention: true, handler: r.id });
		expect(result.status).toBe("attention");
		if (result.status === "attention")
			expect(result.requests).toContainEqual(expect.objectContaining({ kind: "quota", id: b.id }));
		expect(await runtime.decideAgentRequest(r.id, b.id, "approve", undefined, 1_000)).toBe("quota");
	} finally {
		await runtime.abort(r.id).catch(() => {});
	}
});

it("an exhausted ancestor's request goes to its own direct parent", async () => {
	const r = await root();
	const p = await child(r.id, "anc-p", 100);
	const c = await child(p.id, "anc-c", 100);
	await chargeCall(db, c.id, { budget: 150, usage: 150, context: 0 });
	const waiting = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
	// Highest exhausted subagent level first: the parent P, handled by the root.
	const toRoot = await waitFor("the parent's wait", async () => (await awaitingQuotaChildren(db, r.id))[0]);
	expect(toRoot).toMatchObject({ sessionId: c.id, levelId: p.id });
	expect(await runtime.decideAgentRequest(r.id, toRoot.sessionId, "approve", undefined, 1_000_000)).toBe("quota");
	// Then C itself, handled by P.
	const toParent = await waitFor("the child's wait", async () => (await awaitingQuotaChildren(db, p.id))[0]);
	expect(toParent).toMatchObject({ sessionId: c.id, levelId: c.id });
	expect(await runtime.decideAgentRequest(p.id, toParent.sessionId, "approve", undefined, 1_000_000)).toBe("quota");
	expect(await waiting).toBe("ok");
});

it("the API sets a quota on a root at creation and by PATCH, and clears it with null", async () => {
	const created = await call(app, "/api/sessions", {
		cookie: ownerCookie,
		body: { model: model(), rulePreset: "yolo", title: "api root quota", budgetRemaining: 100 },
	});
	expect(created.status).toBe(201);
	const createdBody = (await created.json()) as { session: { id: string; budgetRemaining: number | null } };
	expect(createdBody.session.budgetRemaining).toBe(100);

	const patched = await call(app, `/api/sessions/${createdBody.session.id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { budgetRemaining: 500 },
	});
	expect(patched.status).toBe(200);
	expect(((await patched.json()) as { session: { budgetRemaining: number | null } }).session.budgetRemaining).toBe(500);

	const cleared = await call(app, `/api/sessions/${createdBody.session.id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { budgetRemaining: null },
	});
	expect(cleared.status).toBe(200);
	expect(
		((await cleared.json()) as { session: { budgetRemaining: number | null } }).session.budgetRemaining,
	).toBeNull();

	const invalid = await call(app, "/api/sessions", {
		cookie: ownerCookie,
		body: { model: model(), rulePreset: "yolo", budgetRemaining: -5 },
	});
	expect(invalid.status).toBe(400);

	const r = await root();
	const c = await child(r.id, "api-quota", 10);
	const patchChild = await call(app, `/api/sessions/${c.id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { budgetRemaining: 500 },
	});
	expect(patchChild.status).toBe(200);
	expect((await runtime.getSession(c.id))?.budgetRemaining).toBe(500);
});

it("a root's used-up quota waits for its owner: listed, then granted with an audit", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "yolo",
		title: "root quota wait",
		budgetRemaining: 1,
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "root-quota-tool" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const submission = await runtime.submit(session.id, owner, "go", "root-quota-1");
	await waitFor("the root's quota wait", async () =>
		(await sessionStateOf(db, session.id)) === "awaiting" ? true : undefined,
	);
	const waitingRow = await db
		.selectFrom("sessions")
		.select(["state", "waiting_level_id", "waiting_handler_id"])
		.where("id", "=", session.id)
		.executeTakeFirstOrThrow();
	expect(waitingRow).toMatchObject({ state: "awaiting", waiting_level_id: session.id, waiting_handler_id: null });
	// No agent handles a root wait: the model has not been asked for the next step.
	expect(faux.getPendingResponseCount()).toBe(1);

	const mine = (await (await call(app, "/api/approvals", { cookie: ownerCookie })).json()) as {
		quotas: { sessionId: string; levelId: string; title: string; budgetRemaining: number; budgetUsedTokens: number }[];
	};
	expect(mine.quotas).toEqual([
		expect.objectContaining({ sessionId: session.id, levelId: session.id, title: "root quota wait" }),
	]);
	expect(mine.quotas[0]?.budgetRemaining).toBeLessThanOrEqual(0);

	// Only the owner decides: another member does not even see the session, an administrator may see it but not act.
	await createUser(db, { username: "bob", kind: "member", password: "password-123" });
	const bobCookie = await login(app, "bob", "password-123");
	const theirs = (await (await call(app, "/api/approvals", { cookie: bobCookie })).json()) as { quotas: unknown[] };
	expect(theirs.quotas).toEqual([]);
	const byBob = await call(app, `/api/sessions/${session.id}/quota`, {
		method: "POST",
		cookie: bobCookie,
		body: { decision: "approve", tokens: 1_000 },
	});
	expect(byBob.status).toBe(404);
	await createUser(db, { username: "rootadmin", kind: "admin", password: "password-123" });
	const adminCookie = await login(app, "rootadmin", "password-123");
	const byAdmin = await call(app, `/api/sessions/${session.id}/quota`, {
		method: "POST",
		cookie: adminCookie,
		body: { decision: "approve", tokens: 1_000 },
	});
	expect(byAdmin.status).toBe(403);

	const granted = await call(app, `/api/sessions/${session.id}/quota`, {
		method: "POST",
		cookie: ownerCookie,
		body: { decision: "approve", tokens: 100_000 },
	});
	expect(granted.status).toBe(200);
	expect(await waitSubmission(runtime, session.id, submission)).toEqual({ status: "done", answer: "done" });
	expect((await runtime.getSession(session.id))?.state).toBe("idle");

	const audits = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "quota.granted")
		.where("target_id", "=", session.id)
		.execute();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({
		actor_type: "user",
		actor_id: owner.userId,
		target_type: "session",
		target_id: session.id,
	});
	expect(JSON.parse(audits[0]?.detail ?? "{}")).toMatchObject({ level: session.id, tokens: 100_000 });
});

it("the owner's deny ends the paused root run and audits quota.denied", async () => {
	const session = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "yolo",
		title: "root quota deny",
		budgetRemaining: 1,
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "root-deny-tool" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("should not be requested")]),
	]);
	const submission = await runtime.submit(session.id, owner, "go", "root-quota-deny");
	await waitFor("the root's quota wait", async () =>
		(await sessionStateOf(db, session.id)) === "awaiting" ? true : undefined,
	);
	const denied = await call(app, `/api/sessions/${session.id}/quota`, {
		method: "POST",
		cookie: ownerCookie,
		body: { decision: "deny", reason: "stop spending" },
	});
	expect(denied.status).toBe(200);
	const settled = await waitSubmission(runtime, session.id, submission);
	expect(settled.status).toBe("done");
	// The paused tool ended the run instead of asking the model again.
	expect(faux.getPendingResponseCount()).toBe(1);
	const row = await db
		.selectFrom("sessions")
		.select(["state", "waiting_kind", "waiting_level_id", "waiting_handler_id"])
		.where("id", "=", session.id)
		.executeTakeFirstOrThrow();
	expect(row).toMatchObject({ state: "idle", waiting_kind: null, waiting_level_id: null, waiting_handler_id: null });

	const audits = await db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", "quota.denied")
		.where("target_id", "=", session.id)
		.execute();
	expect(audits).toHaveLength(1);
	expect(audits[0]).toMatchObject({ actor_type: "user", actor_id: owner.userId, target_id: session.id });
	expect(JSON.parse(audits[0]?.detail ?? "{}")).toMatchObject({ level: session.id, reason: "stop spending" });
});

it("a subagent paused on its root's quota is the owner's request, not its parent's", async () => {
	const r = await runtime.createSession(owner, {
		model: model(),
		rulePreset: "yolo",
		title: "ancestor root",
		budgetRemaining: 1,
	});
	const c = await child(r.id, "root-ancestor", null);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "ancestor-tool" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("child done")]),
	]);
	await runtime.startSubagent(c.id, "work", "root-ancestor-submit");
	await waitFor("the subagent's root wait", async () =>
		(await sessionStateOf(db, c.id)) === "awaiting" ? true : undefined,
	);
	const childRow = await db
		.selectFrom("sessions")
		.select(["waiting_level_id", "waiting_handler_id"])
		.where("id", "=", c.id)
		.executeTakeFirstOrThrow();
	expect(childRow).toMatchObject({ waiting_level_id: r.id, waiting_handler_id: null });
	// The root has no run of its own, so it stays idle: the paused child carries the wait on the root level.
	const rootRow = await db
		.selectFrom("sessions")
		.select(["state", "waiting_kind", "waiting_level_id", "waiting_handler_id"])
		.where("id", "=", r.id)
		.executeTakeFirstOrThrow();
	expect(rootRow).toMatchObject({ state: "idle", waiting_kind: null, waiting_level_id: null });
	// The root's agent has nothing to decide: the direct parent of the root level is the owner.
	expect(await runtime.pendingAgentRequests(r.id)).toEqual([]);
	const mine = (await (await call(app, "/api/approvals", { cookie: ownerCookie })).json()) as {
		quotas: { sessionId: string }[];
	};
	expect(mine.quotas.some((quota) => quota.sessionId === r.id)).toBe(true);

	const paused = await runtime.decideRootQuota(r.id, "approve", 100_000);
	expect(paused).toContain(c.id);
	expect(await runtime.waitSubagent(c.id)).toEqual({ status: "done", answer: "child done" });
	expect(await sessionStateOf(db, r.id)).toBe("idle");
});

it("wakes a quota handler after a restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "crh-quota-restart-"));
	const localDb = openDb({ driver: "sqlite", path: join(dir, "crhs.db") });
	await migrateToLatest(localDb);
	const user = await createUser(localDb, { username: "owner", kind: "member", password: "password-123" });
	const localOwner: SessionUser = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	const audit = new Audit(localDb);
	const cluster = new Cluster(localDb, { audit });
	const models = new ModelConfig(localDb, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	const options = {
		db: localDb,
		models,
		cluster,
		taskGroups: new TaskGroups(localDb, cluster, { audit }),
		audit,
	};
	const first = await AgentRuntime.open({
		...options,
		storage: await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" }),
	});
	let second: AgentRuntime | undefined;
	try {
		const r = await first.createSession(localOwner, { model: model(), rulePreset: "yolo" });
		const p = await first.createSubagent(r.id, {
			callKey: "restart-parent",
			task: "parent work",
			rules: { default: "inherit", rules: [] },
			quota: 1_000,
		});
		const c = await first.createSubagent(p.id, {
			callKey: "restart-child",
			task: "child work",
			rules: { default: "inherit", rules: [] },
			quota: 0,
		});
		// The child's first tool call pauses on its own exhausted quota; that wait is what a restart restores.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "restart-quota-tool" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("noted")]),
			fauxAssistantMessage([fauxText("noted again")]),
		]);
		let seen = "";
		const stopFirst = await first.watch(p.id, (events) => {
			seen += JSON.stringify(events);
		});
		await first.startSubagent(c.id, "work", "restart-quota-submit");
		await waitFor("the quota wait", async () =>
			(await sessionStateOf(localDb, c.id)) === "awaiting" ? true : undefined,
		);
		// The request reached the handler; stop the process while the paused call is still pending.
		await waitFor("the parent's wake", async () => (seen.includes("token quota is used up") ? true : undefined));
		stopFirst();
		await first.close();
		// A new process opens the same storage: reconciliation keeps the wait (the run is unsettled) and the
		// parent still holds the request it was woken with.
		second = await AgentRuntime.open({
			...options,
			storage: await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" }),
		});
		const childRow = await localDb
			.selectFrom("sessions")
			.select(["state", "waiting_kind", "waiting_level_id"])
			.where("id", "=", c.id)
			.executeTakeFirstOrThrow();
		expect(childRow).toMatchObject({ state: "awaiting", waiting_kind: "quota", waiting_level_id: c.id });
		seen = "";
		const stop = await second.watch(p.id, (events) => {
			seen += JSON.stringify(events);
		});
		for (let i = 0; i < 40 && !seen.includes("token quota is used up"); i++) {
			await new Promise((r) => setTimeout(r, 50));
		}
		stop();
		expect(seen).toContain("token quota is used up");
		expect(seen).toContain(c.id);
	} finally {
		await second?.close().catch(() => {});
		await first.close().catch(() => {});
		await localDb.destroy();
		await rm(dir, { recursive: true, force: true });
	}
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

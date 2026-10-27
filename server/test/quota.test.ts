import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import {
	ensureQuotaRequest,
	exhaustedLevel,
	grantQuota,
	ownerQuotaRequests,
	parseQuota,
	pendingQuotaRequestsFor,
	recordUsage,
	setQuota,
	spentTokens,
} from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** Signed token quotas (doc/agent-runtime.md#配额): charged after each response, continue only while above zero. */
let db: Db;
let runtime: AgentRuntime;
let owner: SessionUser;
let app: App;
let ownerCookie = "";
let otherCookie = "";
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
		groups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	const user = await createUser(db, { username: "owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	await createUser(db, { username: "other", kind: "member", password: "password-123" });
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	ownerCookie = await login(app, "owner", "password-123");
	otherCookie = await login(app, "other", "password-123");
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

it("accepts a non-negative integer quota or null", () => {
	expect(parseQuota(0)).toBe(0);
	expect(parseQuota(12_345)).toBe(12_345);
	expect(parseQuota(null)).toBeNull();
	for (const bad of [-1, 1.5, "100", undefined, Number.NaN]) expect(() => parseQuota(bad)).toThrow();
});

it("is charged at every level and goes negative", async () => {
	const parent = await runtime.createSession(owner, { model: model(), preset: "yolo", quota: 1_000 });
	const child = await runtime.createSubagent(parent.id, {
		callKey: "quota-child",
		task: "work",
		rules: { default: "inherit", rules: [] },
		quota: 500,
	});
	expect((await runtime.getSession(parent.id))?.quota).toBe(1_000);
	expect((await runtime.getSession(child.id))?.quota).toBe(500);

	await recordUsage(db, child.id, 600);
	// One response overspends the child: a signed negative remainder.
	expect((await runtime.getSession(child.id))?.quota).toBe(-100);
	expect((await runtime.getSession(parent.id))?.quota).toBe(400);
	expect(await spentTokens(db, child.id)).toBe(600);
	expect(await exhaustedLevel(db, child.id)).toBe(child.id);

	// The root is exhausted too: the highest such level is reported first.
	await recordUsage(db, child.id, 500);
	expect(await exhaustedLevel(db, child.id)).toBe(parent.id);
	expect((await runtime.getSession(parent.id))?.quota).toBe(-100);
});

it("setting the quota replaces the remaining amount, so it can clear an overspend", async () => {
	const session = await runtime.createSession(owner, { model: model(), preset: "yolo", quota: 100 });
	await recordUsage(db, session.id, 250);
	expect((await runtime.getSession(session.id))?.quota).toBe(-150);
	expect(await exhaustedLevel(db, session.id)).toBe(session.id);
	// The quota is the remaining amount: setting it grants exactly that much from here on.
	await setQuota(db, session.id, 100);
	expect((await runtime.getSession(session.id))?.quota).toBe(100);
	expect(await exhaustedLevel(db, session.id)).toBeUndefined();
	// Zero is "nothing left": the next input is refused.
	await setQuota(db, session.id, 0);
	expect(await exhaustedLevel(db, session.id)).toBe(session.id);
});

it("a paused child asks its parent's agent, which grants tokens from its own remainder", async () => {
	const parent = await runtime.createSession(owner, { model: model(), preset: "yolo", quota: 1_000_000 });
	const child = await runtime.createSubagent(parent.id, {
		callKey: "quota-pause",
		task: "work",
		rules: { default: "inherit", rules: [] },
		quota: 10,
	});
	await recordUsage(db, child.id, 20);
	expect((await runtime.getSession(child.id))?.quota).toBe(-10);
	faux.setResponses([fauxAssistantMessage([fauxText("noted")])]);
	const waiting = runtime.waitForQuota(child.id, BACKGROUND_CONTEXT);
	const request = await waitFor("the quota request", async () => {
		const pending = await pendingQuotaRequestsFor(db, parent.id);
		return pending[0];
	});
	expect(request).toMatchObject({ sessionId: child.id, levelId: child.id, levelQuota: -10 });
	// The parent's own remainder caps the grant.
	await expect(runtime.decideAgentRequest(parent.id, request.id, "approve", undefined, 5_000_000)).rejects.toThrow(
		/cannot grant more/,
	);
	expect(await runtime.decideAgentRequest(parent.id, request.id, "approve", undefined, 50)).toBe("quota");
	expect(await waiting).toBe("ok");
	expect((await runtime.getSession(child.id))?.quota).toBe(40);
	// Spending still counts at every level.
	expect((await runtime.getSession(parent.id))?.quota).toBeLessThan(1_000_000);
});

it("a denied quota request stops the paused run", async () => {
	const parent = await runtime.createSession(owner, { model: model(), preset: "yolo", quota: 1_000_000 });
	const child = await runtime.createSubagent(parent.id, {
		callKey: "quota-deny",
		task: "work",
		rules: { default: "inherit", rules: [] },
		quota: 10,
	});
	await recordUsage(db, child.id, 20);
	faux.setResponses([fauxAssistantMessage([fauxText("noted")])]);
	const waiting = runtime.waitForQuota(child.id, BACKGROUND_CONTEXT);
	const request = await waitFor("the quota request", async () => (await pendingQuotaRequestsFor(db, parent.id))[0]);
	expect(await runtime.decideAgentRequest(parent.id, request.id, "deny")).toBe("quota");
	expect(await waiting).toBe("denied");
	expect(await runtime.getSession(child.id)).toMatchObject({ quota: -10 });
});

it("with no ancestor able to pay, the owner gets the request", async () => {
	const root = await runtime.createSession(owner, { model: model(), preset: "yolo", quota: 10 });
	await recordUsage(db, root.id, 30);
	expect((await runtime.getSession(root.id))?.quota).toBe(-20);
	const waiting = runtime.waitForQuota(root.id, BACKGROUND_CONTEXT);
	const request = await waitFor("the owner's request", async () => (await ownerQuotaRequests(db, owner.userId))[0]);
	expect(request).toMatchObject({ sessionId: root.id, levelId: root.id, handlerSessionId: null });
	expect(await grantQuota(db, request.id, 100)).toMatchObject({ state: "granted", grantedTokens: 100 });
	expect(await waiting).toBe("ok");
	expect((await runtime.getSession(root.id))?.quota).toBe(80);
});

it("a subagent cannot be given more than the parent has left", async () => {
	const parent = await runtime.createSession(owner, { model: model(), preset: "yolo", quota: 1_000 });
	await expect(
		runtime.createSubagent(parent.id, {
			callKey: "too-much",
			task: "work",
			rules: { default: "inherit", rules: [] },
			quota: 5_000,
		}),
	).rejects.toThrow(/exceeds what is left/);
	// A limited parent must hand the child a quota.
	await expect(
		runtime.createSubagent(parent.id, {
			callKey: "no-quota",
			task: "work",
			rules: { default: "inherit", rules: [] },
			quota: null,
		}),
	).rejects.toThrow(/give the subagent a quota/);
});

it("owner quota requests over the API: list, grant, deny, permissions", async () => {
	const s = await runtime.createSession(owner, { model: model(), preset: "yolo", quota: 100 });
	await recordUsage(db, s.id, 150);
	const request = await ensureQuotaRequest(db, { sessionId: s.id, levelId: s.id, handlerSessionId: null });

	const listed = await call(app, "/api/quota-requests", { cookie: ownerCookie });
	expect(((await listed.json()) as { requests: { id: string }[] }).requests.map((r) => r.id)).toContain(request.id);
	expect(
		((await (await call(app, "/api/quota-requests", { cookie: otherCookie })).json()) as { requests: unknown[] })
			.requests,
	).toEqual([]);
	expect(
		(await call(app, `/api/quota-requests/${request.id}/grant`, { cookie: otherCookie, body: { tokens: 10 } })).status,
	).toBe(403);
	expect(
		(await call(app, `/api/quota-requests/${request.id}/grant`, { cookie: ownerCookie, body: { tokens: -1 } })).status,
	).toBe(400);

	const granted = await call(app, `/api/quota-requests/${request.id}/grant`, {
		cookie: ownerCookie,
		body: { tokens: 100 },
	});
	expect(granted.status).toBe(200);
	// -50 + 100
	expect((await runtime.getSession(s.id))?.quota).toBe(50);
	expect(
		(await call(app, `/api/quota-requests/${request.id}/grant`, { cookie: ownerCookie, body: { tokens: 1 } })).status,
	).toBe(409);

	const s2 = await runtime.createSession(owner, { model: model(), preset: "yolo", quota: 10 });
	await recordUsage(db, s2.id, 30);
	const denied = await ensureQuotaRequest(db, { sessionId: s2.id, levelId: s2.id, handlerSessionId: null });
	const res = await call(app, `/api/quota-requests/${denied.id}/deny`, { cookie: ownerCookie, body: {} });
	expect(res.status).toBe(200);
	expect((await runtime.getSession(s2.id))?.quota).toBe(-20);
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

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import {
	exhaustedLevel,
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

/**
 * Quotas manage subagents (D76): roots have quota 0 and are not charged, each response charges every subagent
 * level, and an exhausted level asks its direct parent only (D77).
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
		groups: new TaskGroups(db, cluster, { audit }),
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

const root = (title = "root") => runtime.createSession(owner, { model: model(), preset: "yolo", title });
const child = (parentId: string, key: string, quota: number | null, rules = { default: "inherit", rules: [] }) =>
	runtime.createSubagent(parentId, { callKey: key, task: `task ${key}`, rules: rules as never, quota });

it("accepts a non-negative integer quota or null", () => {
	expect(parseQuota(0)).toBe(0);
	expect(parseQuota(12_345)).toBe(12_345);
	expect(parseQuota(null)).toBeNull();
	for (const bad of [-1, 1.5, "100", undefined, Number.NaN]) expect(() => parseQuota(bad)).toThrow();
});

it("root sessions have quota 0 and are never charged", async () => {
	const r = await root();
	expect((await runtime.getSession(r.id))?.quota).toBe(0);
	await recordUsage(db, r.id, 500);
	expect((await runtime.getSession(r.id))?.quota).toBe(0);
	expect(await spentTokens(db, r.id)).toBe(500);
	expect(await exhaustedLevel(db, r.id)).toBeUndefined();
});

it("each response charges every subagent level of the chain, not the root", async () => {
	const r = await root();
	const p = await child(r.id, "chain-p", 1_000);
	const c = await child(p.id, "chain-c", 500);
	await recordUsage(db, c.id, 600);
	expect((await runtime.getSession(c.id))?.quota).toBe(-100);
	expect((await runtime.getSession(p.id))?.quota).toBe(400);
	expect((await runtime.getSession(r.id))?.quota).toBe(0);
	expect(await exhaustedLevel(db, c.id)).toBe(c.id);
	await recordUsage(db, c.id, 500);
	expect(await exhaustedLevel(db, c.id)).toBe(p.id);
	expect((await runtime.getSession(p.id))?.quota).toBe(-100);
});

it("setting a subagent's quota replaces the remaining amount", async () => {
	const r = await root();
	const c = await child(r.id, "replace", 100);
	await recordUsage(db, c.id, 250);
	expect((await runtime.getSession(c.id))?.quota).toBe(-150);
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
	await recordUsage(db, c.id, 20);
	const waiting = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
	const request = await waitFor("the quota request", async () => (await pendingQuotaRequestsFor(db, p.id))[0]);
	expect(request).toMatchObject({ sessionId: c.id, levelId: c.id, handlerSessionId: p.id });
	// No cap: the parent's own remainder does not limit what it adds for its child.
	expect(await runtime.decideAgentRequest(p.id, request.id, "approve", undefined, 50_000_000)).toBe("quota");
	expect(await waiting).toBe("ok");
	expect((await runtime.getSession(c.id))?.quota).toBe(50_000_000 - 10);
});

it("a denied request stops the paused run", async () => {
	const r = await root();
	const p = await child(r.id, "deny-p", 10_000_000);
	const c = await child(p.id, "deny-c", 10);
	await recordUsage(db, c.id, 20);
	const waiting = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
	const request = await waitFor("the quota request", async () => (await pendingQuotaRequestsFor(db, p.id))[0]);
	expect(await runtime.decideAgentRequest(p.id, request.id, "deny")).toBe("quota");
	expect(await waiting).toBe("denied");
});

it("an exhausted ancestor's request goes to its own direct parent", async () => {
	const r = await root();
	const p = await child(r.id, "anc-p", 100);
	const c = await child(p.id, "anc-c", 100);
	await recordUsage(db, c.id, 150);
	const waiting = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
	// Highest exhausted subagent level first: the parent P, handled by the root.
	const toRoot = await waitFor("the parent's request", async () => (await pendingQuotaRequestsFor(db, r.id))[0]);
	expect(toRoot).toMatchObject({ sessionId: c.id, levelId: p.id, handlerSessionId: r.id });
	expect(await runtime.decideAgentRequest(r.id, toRoot.id, "approve", undefined, 1_000_000)).toBe("quota");
	// Then C itself, handled by P.
	const toParent = await waitFor("the child's request", async () => (await pendingQuotaRequestsFor(db, p.id))[0]);
	expect(toParent).toMatchObject({ sessionId: c.id, levelId: c.id, handlerSessionId: p.id });
	expect(await runtime.decideAgentRequest(p.id, toParent.id, "approve", undefined, 1_000_000)).toBe("quota");
	expect(await waiting).toBe("ok");
});

it("the API refuses a quota on a root session and allows one on a subagent", async () => {
	const created = await call(app, "/api/sessions", {
		cookie: ownerCookie,
		body: { model: model(), preset: "yolo", quota: 100 },
	});
	expect(created.status).toBe(400);

	const r = await root();
	const c = await child(r.id, "api-quota", 10);
	const patchRoot = await call(app, `/api/sessions/${r.id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { quota: 100 },
	});
	expect(patchRoot.status).toBe(400);
	const patchChild = await call(app, `/api/sessions/${c.id}`, {
		method: "PATCH",
		cookie: ownerCookie,
		body: { quota: 500 },
	});
	expect(patchChild.status).toBe(200);
	expect((await runtime.getSession(c.id))?.quota).toBe(500);
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

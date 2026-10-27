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
	exhaustedLevel,
	parseQuota,
	recordUsage,
	sessionStateOf,
	setQuota,
	setSessionState,
	spentTokens,
} from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
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
	expect(await sessionStateOf(db, c.id)).toBe("active");
	const resumed = await db
		.selectFrom("sessions")
		.select(["waiting_level_id", "waiting_handler_id"])
		.where("id", "=", c.id)
		.executeTakeFirstOrThrow();
	expect(resumed).toMatchObject({ waiting_level_id: null, waiting_handler_id: null });
	expect((await runtime.getSession(c.id))?.quota).toBe(50_000_000 - 10);
});

it("a finished subagent is stopped until the next input", async () => {
	const r = await root();
	const c = await child(r.id, "done-child", null);
	faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
	await runtime.startSubagent(c.id, "work", "sub-1");
	expect(await runtime.waitSubagent(c.id)).toEqual({ status: "done", answer: "done" });
	await waitFor("stopped", async () => ((await sessionStateOf(db, c.id)) === "stopped" ? true : undefined));
});

it("a denied request stops the paused run", async () => {
	const r = await root();
	const p = await child(r.id, "deny-p", 10_000_000);
	const c = await child(p.id, "deny-c", 10);
	await recordUsage(db, c.id, 20);
	const waiting = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
	const request = await waitFor("the quota wait", async () => (await awaitingQuotaChildren(db, p.id))[0]);
	expect(await runtime.decideAgentRequest(p.id, request.sessionId, "deny")).toBe("quota");
	expect(await waiting).toBe("denied");
	expect(await sessionStateOf(db, c.id)).toBe("stopped");
});

it("a denial stops a run that is still paused in waitForQuota", async () => {
	const r = await root();
	const p = await child(r.id, "live-deny-p", null);
	const c = await child(p.id, "live-deny-c", 10);
	await recordUsage(db, c.id, 20);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("exec", { node: "missing", cmd: "true" }, { id: "q1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("noted")]),
	]);
	await runtime.startSubagent(c.id, "work", "live-deny-submit");
	try {
		const request = await waitFor("the live quota wait", async () => (await awaitingQuotaChildren(db, p.id))[0]);
		expect(await sessionStateOf(db, c.id)).toBe("awaiting");
		expect(await runtime.decideAgentRequest(p.id, request.sessionId, "deny")).toBe("quota");
		// The run is still live while its tool call ends; a read must not turn the stop back into a wait.
		expect(await runtime.refreshState(c.id)).toBe("stopped");
		expect(await sessionStateOf(db, c.id)).toBe("stopped");
		const result = await Promise.race([
			runtime.waitSubagent(c.id),
			new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 2000)),
		]);
		expect(result).not.toBe("still-waiting");
		expect(await sessionStateOf(db, c.id)).toBe("stopped");
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
		await recordUsage(db, c.id, 20);
		const first = runtime.waitForQuota(c.id, BACKGROUND_CONTEXT);
		await waitFor("the first pause", async () => (await awaitingQuotaChildren(db, p.id))[0]);
		await waitFor("the first wake", async () =>
			(seen.match(/token quota is used up/g)?.length ?? 0) >= 1 ? true : undefined,
		);
		expect(await runtime.decideAgentRequest(p.id, c.id, "approve", undefined, 20)).toBe("quota");
		expect(await first).toBe("ok");
		expect(await sessionStateOf(db, c.id)).toBe("active");

		// The same level runs out again: this is a new pause, so the parent must hear about it again.
		await recordUsage(db, c.id, 20);
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
	await recordUsage(db, c.id, 20);
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
		fauxAssistantMessage([fauxToolCall("exec", { node: "missing", cmd: "true" }, { id: "idle-q1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("wake handled")]),
	]);
	let seen = "";
	const stop = await runtime.watch(p.id, (events) => {
		seen += JSON.stringify(events);
	});
	try {
		await runtime.submit(p.id, owner, "be busy for a moment", "idle-flush-parent");
		await started;
		// The parent is live; the quota request must be queued, not dropped, and delivered when the run ends.
		await runtime.startSubagent(c.id, "work", "idle-flush-child");
		await waitFor("the flushed wake", async () => (seen.includes("token quota is used up") ? true : undefined));
		expect(faux.getPendingResponseCount()).toBe(0);
		expect(await runtime.decideAgentRequest(p.id, c.id, "approve", undefined, 1_000)).toBe("quota");
	} finally {
		stop();
		await runtime.abort(r.id).catch(() => {});
	}
});

it("an exhausted ancestor's request goes to its own direct parent", async () => {
	const r = await root();
	const p = await child(r.id, "anc-p", 100);
	const c = await child(p.id, "anc-c", 100);
	await recordUsage(db, c.id, 150);
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
		groups: new TaskGroups(localDb, cluster, { audit }),
		audit,
	};
	const first = await AgentRuntime.open({
		...options,
		storage: await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" }),
	});
	let second: AgentRuntime | undefined;
	try {
		const r = await first.createSession(localOwner, { model: model(), preset: "yolo" });
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
			quota: 10,
		});
		await recordUsage(localDb, c.id, 20);
		await setSessionState(localDb, c.id, "awaiting", c.id);
		faux.setResponses([fauxAssistantMessage([fauxText("noted")])]);
		await first.close();
		// A new process opens the same storage: the pending request wakes its handler.
		second = await AgentRuntime.open({
			...options,
			storage: await openNodeSqliteStorage(join(dir, "durable.sqlite"), { prefix: "pi_" }),
		});
		let seen = "";
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

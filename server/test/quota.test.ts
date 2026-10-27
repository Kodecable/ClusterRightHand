import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { exhaustedLevel, parseQuota, recordUsage, setQuota, spentTokens } from "../src/agent/quota.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { openTestDb } from "./helpers/db.ts";

/** Signed token quotas (doc/agent-runtime.md#配额): charged after each response, continue only while above zero. */
let db: Db;
let runtime: AgentRuntime;
let owner: SessionUser;
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
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

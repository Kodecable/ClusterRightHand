import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import type { RuntimeHost } from "../src/agent/runtime-core.ts";
import { configure } from "../src/agent/runtime-sessions.ts";
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

/** Configuring a session (doc/agent-runtime.md#会话): rule preset, quota, model and title. */
let db: Db;
let cluster: Cluster;
let groups: TaskGroups;
let audit: Audit;
let models: ModelConfig;
let runtime: AgentRuntime;
let app: App;
let owner: SessionUser;
let cookie = "";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	cluster = new Cluster(db, { audit });
	groups = new TaskGroups(db, cluster, { audit });
	const masterKey = MasterKey.generate();
	models = new ModelConfig(db, masterKey);
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
	const user = await createUser(db, { username: "configure-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	app = makeApp(db, undefined, { cluster, taskGroups: groups, audit, masterKey, agent: { runtime, models } });
	cookie = await login(app, user.username, "password-123");
});

afterAll(async () => {
	await runtime.waitForIdle();
	await runtime.close();
	await cluster.close();
	await groups.close();
	await db.destroy();
});

const root = (title = "configurable") =>
	runtime.createSession(owner, { title, model: model(), rulePreset: "yolo", budgetRemaining: 100 });

const sessionRow = (id: string) => db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

it("rejects a rule preset on a subagent's session", async () => {
	const parent = await root();
	const child = await runtime.createSubagent(parent.id, {
		callKey: "configure-child",
		task: "look around",
		rules: { default: "inherit", rules: [] },
		quota: null,
	});
	const res = await call(app, `/api/sessions/${child.id}`, {
		method: "PATCH",
		cookie,
		body: { rulePreset: "ask" },
	});
	expect(res.status).toBe(400);
	expect(((await res.json()) as { error: string }).error).toContain("set by its parent");
	// The request changed nothing: a subagent's level keeps the inherit default its parent gave it.
	const rules = await db
		.selectFrom("rule_sets")
		.selectAll()
		.where("scope_type", "=", "session")
		.where("scope_id", "=", child.id)
		.executeTakeFirstOrThrow();
	expect(rules).toMatchObject({ rule_preset: null, default_action: "inherit" });
});

it("rolls back the quota and title when the rule preset write fails", async () => {
	const session = await root("unchanged");
	const before = await sessionRow(session.id);
	// Without its rule set the preset update fails after the quota and title were written, so the whole
	// transaction has to roll back.
	await db.deleteFrom("rule_sets").where("scope_type", "=", "session").where("scope_id", "=", session.id).execute();

	const res = await call(app, `/api/sessions/${session.id}`, {
		method: "PATCH",
		cookie,
		body: { title: "changed", budgetRemaining: 500, rulePreset: "ask" },
	});
	expect(res.status).toBe(404);
	const after = await sessionRow(session.id);
	expect(after.title).toBe("unchanged");
	expect(Number(after.quota_tokens)).toBe(100);
	expect(after.updated_at).toBe(before.updated_at);
});

it("restores the row when the conversation refuses the new model", async () => {
	const session = await root("kept title");
	const before = await sessionRow(session.id);
	const beforeRules = await db
		.selectFrom("rule_sets")
		.selectAll()
		.where("scope_type", "=", "session")
		.where("scope_id", "=", session.id)
		.executeTakeFirstOrThrow();
	const conversation = {
		configure: vi.fn(async () => {
			throw new Error("the provider refused the model");
		}),
	};
	const host = {
		db,
		models,
		context: BACKGROUND_CONTEXT,
		audit: undefined,
		closing: () => false,
		harness: () => ({ conversation: async () => conversation }),
		sessionList: { publishSession: () => {} },
	} as unknown as RuntimeHost;

	await expect(
		configure(host, session.id, {
			title: "new title",
			model: model(),
			rulePreset: "ask",
			budgetRemaining: 500,
		}),
	).rejects.toThrow("the provider refused the model");
	expect(conversation.configure).toHaveBeenCalledTimes(1);

	// The conversation kept the old model, so the row (and the rule preset) must describe the old one again.
	const after = await sessionRow(session.id);
	expect(after.title).toBe(before.title);
	expect(after.model).toBe(before.model);
	expect(Number(after.quota_tokens)).toBe(Number(before.quota_tokens));
	expect(after.updated_at).toBe(before.updated_at);
	const afterRules = await db
		.selectFrom("rule_sets")
		.selectAll()
		.where("scope_type", "=", "session")
		.where("scope_id", "=", session.id)
		.executeTakeFirstOrThrow();
	expect(afterRules.rule_preset).toBe(beforeRules.rule_preset);
	expect(afterRules.default_action).toBe(beforeRules.default_action);
});

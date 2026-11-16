import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
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
 * Stopping a session's turn is audited once, in the runtime, with where it came from
 * (doc/design/access-control.md "Recorded events"): the WebUI, `/stop` and a stopped progress draft all
 * take the same path.
 */

const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

let db: Db;
let runtime: AgentRuntime;
let audit: Audit;
let app: App;
let models: ModelConfig;
let owner: SessionUser;
let cookie: string;

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const groups = new TaskGroups(db, cluster, { audit });
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
	app = makeApp(db, undefined, {
		cluster,
		taskGroups: groups,
		audit,
		masterKey: MasterKey.generate(),
		agent: { runtime, models },
	});
	const user = await createUser(db, { username: "stop-owner", kind: "member", password: "password-123" });
	owner = { sessionId: "test", userId: user.id, username: user.username, kind: "member" };
	cookie = await login(app, "stop-owner", "password-123");
});

afterAll(async () => {
	await runtime.close();
	await db.destroy();
});

const stops = async (sessionId: string) => {
	await audit.flush();
	return db
		.selectFrom("audit_events")
		.select(["actor_type", "actor_id", "detail"])
		.where("action", "=", "session.stop")
		.where("target_id", "=", sessionId)
		.execute();
};

it("records the source of every stop path", async () => {
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "stops" });
	await runtime.abort(session.id, owner, { source: "web" });
	await runtime.abort(session.id, owner, {
		source: "channel_command",
		channel: "bot",
		platform: "telegram",
		accountId: "account-1",
		threadId: "thread-1",
	});
	await runtime.abort(session.id, owner, {
		source: "channel_draft_stop",
		channel: "bot",
		platform: "telegram",
		accountId: "account-1",
		threadId: "thread-1",
	});
	const events = await stops(session.id);
	expect(
		events.map((event) => ({ actor: `${event.actor_type}:${event.actor_id}`, ...JSON.parse(event.detail) })),
	).toEqual([
		{ actor: `user:${owner.userId}`, source: "web" },
		{
			actor: `user:${owner.userId}`,
			source: "channel_command",
			channel: "bot",
			via: "telegram",
			channel_account: "account-1",
			thread_id: "thread-1",
		},
		{
			actor: `user:${owner.userId}`,
			source: "channel_draft_stop",
			channel: "bot",
			via: "telegram",
			channel_account: "account-1",
			thread_id: "thread-1",
		},
	]);
});

it("records the WebUI abort route as source web", async () => {
	const session = await runtime.createSession(owner, { model: model(), rulePreset: "yolo", title: "web stop" });
	const res = await call(app, `/api/sessions/${session.id}/abort`, { cookie, body: {} });
	expect(res.status).toBe(200);
	const events = await stops(session.id);
	expect(events).toHaveLength(1);
	expect(JSON.parse(events[0]?.detail ?? "{}")).toMatchObject({ source: "web" });
});

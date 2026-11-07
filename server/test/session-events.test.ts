import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { RequestDrain } from "../src/api/drain.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

const PASSWORD = "session-events-password";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

let db: Db;
let app: App;
let runtime: AgentRuntime;
let drain: RequestDrain;
let alice = "";
let bob = "";
let sessionId = "";

/** Whether the drain is idle within a short grace period, i.e. no event stream is still holding it. */
async function drainIdle(ms = 100): Promise<boolean> {
	return Promise.race([
		drain.waitForIdle().then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);
}

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
	drain = new RequestDrain();
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models }, drain });

	const aliceRow = await createUser(db, { username: "alice", kind: "member", password: PASSWORD });
	await createUser(db, { username: "bob", kind: "member", password: PASSWORD });
	alice = await login(app, "alice", PASSWORD);
	bob = await login(app, "bob", PASSWORD);
	const owner: SessionUser = {
		sessionId: "test-alice",
		userId: aliceRow.id,
		username: aliceRow.username,
		kind: aliceRow.kind,
	};
	sessionId = (await runtime.createSession(owner, { title: "event stream", model: model(), rulePreset: "ask" })).id;
});

afterAll(async () => {
	drain.begin();
	await runtime.close();
	await db.destroy();
});

it("answers HEAD with the access checks and opens no stream", async () => {
	const visible = await call(app, `/api/sessions/${sessionId}/events`, { method: "HEAD", cookie: alice });
	expect(visible.status).toBe(200);
	expect(await visible.text()).toBe("");
	// A stream would still hold the drain after the response returned.
	expect(await drainIdle()).toBe(true);

	// Invisible and unknown sessions are the same 404 as the GET route; a HEAD with no session is a 401.
	expect((await call(app, `/api/sessions/${sessionId}/events`, { method: "HEAD", cookie: bob })).status).toBe(404);
	expect((await call(app, "/api/sessions/does-not-exist/events", { method: "HEAD", cookie: alice })).status).toBe(404);
	expect((await call(app, `/api/sessions/${sessionId}/events`, { method: "HEAD" })).status).toBe(401);
	expect(await drainIdle()).toBe(true);
});

import type { SessionExtension } from "@crh/api";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import type { SessionUser } from "../src/auth/sessions.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { McpConnections } from "../src/extensions/connections.ts";
import { saveExtension } from "../src/extensions/store.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The draft's extensions (doc/design/extensions.md "Extensions"): the list a new session reaches before it
 * exists and the off switches the create request starts it with. Both use the same resolution as a session's
 * own `extensions`, so the draft's choices match what the created session shows and what its first turn offers.
 */

const PASSWORD = "session-extensions-password";
const faux = fauxProvider();
const model = () => ({ provider: faux.provider.id, modelId: faux.getModel().id });

let db: Db;
let app: App;
let runtime: AgentRuntime;
let mcp: McpConnections;
let alice: SessionUser;
let bob: SessionUser;
let aliceCookie = "";
let bobCookie = "";

const extensionsOf = async (cookie: string): Promise<SessionExtension[]> => {
	const res = await call(app, "/api/sessions/extensions", { cookie });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { extensions: SessionExtension[] };
	return body.extensions;
};

beforeAll(async () => {
	db = await openTestDb("sqlite");
	const audit = new Audit(db);
	const cluster = new Cluster(db, { audit });
	const groups = new TaskGroups(db, cluster, { audit });
	const models = new ModelConfig(db, MasterKey.generate());
	models.addProvider(faux.provider);
	await models.reload();
	const masterKey = MasterKey.generate();
	mcp = new McpConnections({ db, masterKey });
	runtime = await AgentRuntime.open({
		db,
		storage: new MemoryStorage(),
		models,
		cluster,
		taskGroups: groups,
		audit,
		mcp,
	});
	const created = await createUser(db, { username: "alice", kind: "member", password: PASSWORD });
	alice = { sessionId: "test", userId: created.id, username: created.username, kind: "member" };
	const createdBob = await createUser(db, { username: "bob", kind: "member", password: PASSWORD });
	bob = { sessionId: "test", userId: createdBob.id, username: createdBob.username, kind: "member" };
	// An MCP extension granted only to Alice: Bob's draft must not list it, and his create must not see it.
	await saveExtension(
		db,
		masterKey,
		"alpha",
		{
			url: "http://mcp.test/mcp",
			description: "Alpha tools",
			grants: [{ granteeType: "user", granteeId: alice.userId }],
		},
		alice.userId,
	);
	app = makeApp(db, undefined, { cluster, taskGroups: groups, audit, masterKey, mcp, agent: { runtime, models } });
	aliceCookie = await login(app, alice.username, PASSWORD);
	bobCookie = await login(app, bob.username, PASSWORD);
});

afterAll(async () => {
	await runtime.waitForIdle();
	await runtime.close();
	await mcp.close();
	await db.destroy();
});

it("lists the extensions available to the caller, all on", async () => {
	const granted = await extensionsOf(aliceCookie);
	expect(granted.map((extension) => extension.name)).toEqual(["alpha", "crhs-api", "crhs-docs"]);
	for (const extension of granted) {
		expect(extension.enabled).toBe(true);
		expect(extension.available).toBe(true);
	}
	expect(granted[0]).toMatchObject({ name: "alpha", kind: "mcp", description: "Alpha tools" });

	// Without the grant the MCP extension is not part of the draft, exactly as it would not be in the session.
	const ungranted = await extensionsOf(bobCookie);
	expect(ungranted.map((extension) => extension.name)).toEqual(["crhs-api", "crhs-docs"]);
});

it("creates a session with the draft's off switches stored and the first turn already without them", async () => {
	let firstTurnTools: string[] = [];
	faux.setResponses([
		(context) => {
			firstTurnTools = getCurrentTools(context.messages).map((tool) => tool.name);
			return fauxAssistantMessage([fauxText("done")]);
		},
	]);
	const res = await call(app, "/api/sessions", {
		cookie: aliceCookie,
		body: {
			requestId: "extensions-create-1",
			message: "hello",
			title: "Started without the docs",
			model: model(),
			rulePreset: "ask",
			disabledExtensions: ["crhs-docs"],
		},
	});
	expect(res.status).toBe(201);
	const { session } = (await res.json()) as {
		session: { id: string; extensions: SessionExtension[] };
	};
	const docs = session.extensions.find((extension) => extension.name === "crhs-docs");
	const api = session.extensions.find((extension) => extension.name === "crhs-api");
	expect(docs?.enabled).toBe(false);
	expect(api?.enabled).toBe(true);

	await runtime.waitForIdle();
	await vi.waitFor(() => expect(firstTurnTools.length).toBeGreaterThan(0));
	expect(firstTurnTools).toContain("ext__crhs-api__api_request");
	expect(firstTurnTools).not.toContain("ext__crhs-docs__search_docs");

	// The same row backs GET /api/sessions/{id}: the toggle persists and a later turn keeps the set.
	const row = await db
		.selectFrom("sessions")
		.select("disabled_extensions")
		.where("id", "=", session.id)
		.executeTakeFirstOrThrow();
	expect(JSON.parse(row.disabled_extensions ?? "[]")).toEqual(["crhs-docs"]);
	const get = await call(app, `/api/sessions/${session.id}`, { cookie: aliceCookie });
	expect(get.status).toBe(200);
	const detail = (await get.json()) as { session: { extensions: SessionExtension[] } };
	expect(detail.session.extensions.find((extension) => extension.name === "crhs-docs")?.enabled).toBe(false);
});

it("rejects an unavailable name as PATCH does, and a malformed list through the schema", async () => {
	const created = await runtime.createSession(alice, {
		title: "Patchable",
		model: model(),
		rulePreset: "ask",
	});

	const createdRes = await call(app, "/api/sessions", {
		cookie: aliceCookie,
		body: {
			requestId: "extensions-create-bad",
			message: "hello",
			model: model(),
			rulePreset: "ask",
			disabledExtensions: ["nope"],
		},
	});
	expect(createdRes.status).toBe(400);
	const createError = ((await createdRes.json()) as { error: string }).error;
	expect(createError).toContain("no extension named nope is available to the session's owner");

	const patched = await call(app, `/api/sessions/${created.id}`, {
		method: "PATCH",
		cookie: aliceCookie,
		body: { disabledExtensions: ["nope"] },
	});
	expect(patched.status).toBe(400);
	expect(((await patched.json()) as { error: string }).error).toBe(createError);

	// Bob cannot start a session with Alice's granted extension, like PATCH on a session he owns.
	const bobUsesAlpha = await call(app, "/api/sessions", {
		cookie: bobCookie,
		body: {
			requestId: "extensions-create-bob",
			message: "hello",
			model: model(),
			rulePreset: "ask",
			disabledExtensions: ["alpha"],
		},
	});
	expect(bobUsesAlpha.status).toBe(400);
	expect(((await bobUsesAlpha.json()) as { error: string }).error).toContain("no extension named alpha");

	const wrongShape = await call(app, "/api/sessions", {
		cookie: aliceCookie,
		body: {
			requestId: "extensions-create-shape",
			message: "hello",
			model: model(),
			rulePreset: "ask",
			disabledExtensions: "crhs-docs",
		},
	});
	expect(wrongShape.status).toBe(400);
	expect(((await wrongShape.json()) as { error: string }).error).toMatch(/^disabledExtensions: /);
});

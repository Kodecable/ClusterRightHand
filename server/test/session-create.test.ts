import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** POST /api/sessions creates the session and submits its first message in one idempotent request. */
let db: Db;
let app: App;
let runtime: AgentRuntime;
let storage: MemoryStorage;
let cookie = "";
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
	storage = new MemoryStorage();
	runtime = await AgentRuntime.open({
		db,
		storage,
		models,
		cluster,
		taskGroups: new TaskGroups(db, cluster, { audit }),
		audit,
	});
	await createUser(db, { username: "creator", kind: "member", password: "password-123" });
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	cookie = await login(app, "creator", "password-123");
});

afterAll(async () => {
	await runtime.waitForIdle();
	await runtime.close();
	await db.destroy();
});

const create = (body: Record<string, unknown>) => call(app, "/api/sessions", { cookie, body });

const sessionRows = (requestId: string) =>
	db.selectFrom("sessions").selectAll().where("create_request_id", "=", requestId).execute();

it("creates the session and submits the message in one request, returning 201", async () => {
	const requestId = "create-and-send";
	faux.setResponses([fauxAssistantMessage([fauxText("the first answer")])]);
	const res = await create({
		requestId,
		model: model(),
		rulePreset: "yolo",
		title: "First answer",
		message: " hello ",
	});
	expect(res.status).toBe(201);
	const body = (await res.json()) as { session: { id: string; title: string | null } };
	expect(body.session.title).toBe("First answer");

	await runtime.waitForIdle();
	const rows = await sessionRows(requestId);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ id: body.session.id, title: "First answer", title_pending: 0 });
	const conversationId = Number(rows[0]?.conversation_id) as never;
	const entries = await runtime.entriesPage(body.session.id, undefined, 100);
	expect(entries.entries.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["pi.user", "pi.assistant"]));
	const submissions = await storage.scanSubmissions({ conversationId }, 10, undefined, BACKGROUND_CONTEXT);
	expect(submissions.items).toHaveLength(1);
});

it("returns the existing session for the same requestId and submits once", async () => {
	const requestId = "same-request-twice";
	const callsBefore = faux.state.callCount;
	faux.setResponses([fauxAssistantMessage([fauxText("only once")])]);
	const first = await create({
		requestId,
		model: model(),
		rulePreset: "ask",
		title: "Same request",
		message: "hello",
	});
	expect(first.status).toBe(201);
	const firstId = ((await first.json()) as { session: { id: string } }).session.id;
	await runtime.waitForIdle();

	const second = await create({
		requestId,
		model: model(),
		rulePreset: "ask",
		title: "Same request",
		message: "a different retry",
	});
	expect(second.status).toBe(200);
	expect(((await second.json()) as { session: { id: string } }).session.id).toBe(firstId);
	expect(await sessionRows(requestId)).toHaveLength(1);

	const row = (await sessionRows(requestId))[0];
	const conversationId = Number(row?.conversation_id) as never;
	const submissions = await storage.scanSubmissions({ conversationId }, 10, undefined, BACKGROUND_CONTEXT);
	expect(submissions.items).toHaveLength(1);
	// The scripted answer was called once: the retry did not start another run.
	expect(faux.state.callCount - callsBefore).toBe(1);
});

it("returns one session when two requests with the same requestId race", async () => {
	const requestId = "concurrent-create";
	faux.setResponses([fauxAssistantMessage([fauxText("once")])]);
	const body = { requestId, model: model(), rulePreset: "ask", title: "Concurrent", message: "hello" };
	const [first, second] = await Promise.all([create(body), create(body)]);
	expect([first.status, second.status].sort()).toEqual([200, 201]);
	const ids = [
		((await first.json()) as { session: { id: string } }).session.id,
		((await second.json()) as { session: { id: string } }).session.id,
	];
	expect(ids[0]).toBe(ids[1]);
	expect(await sessionRows(requestId)).toHaveLength(1);
	await runtime.waitForIdle();
});

it("requires a non-empty message and requestId of at most 128 characters", async () => {
	const ok = { model: model(), rulePreset: "ask" };
	for (const body of [
		{ ...ok, message: "hello" },
		{ ...ok, requestId: "", message: "hello" },
		{ ...ok, requestId: "   ", message: "hello" },
		{ ...ok, requestId: "x".repeat(129), message: "hello" },
		{ ...ok, requestId: "no-message" },
		{ ...ok, requestId: "empty-message", message: "" },
		{ ...ok, requestId: "spaces", message: "   " },
		{ ...ok, requestId: "number", message: 5 },
	]) {
		expect((await create(body)).status).toBe(400);
	}
});

it("deletes the session and its rule set when submitting the first message fails", async () => {
	const requestId = "failed-first-message";
	// A budget of 0 is exhausted at the first submission, after the session row was created.
	const before = await db.selectFrom("sessions").select("id").execute();
	const res = await create({
		requestId,
		model: model(),
		rulePreset: "yolo",
		budgetRemaining: 0,
		message: "this cannot run",
	});
	expect(res.status).toBe(400);
	expect(((await res.json()) as { error: string }).error).toContain("token quota is used up");
	expect(await sessionRows(requestId)).toEqual([]);
	const rules = await db.selectFrom("rule_sets").selectAll().where("scope_id", "=", requestId).execute();
	expect(rules).toEqual([]);
	expect(await db.selectFrom("sessions").select("id").execute()).toHaveLength(before.length);
});

it("keeps the title rules: no title is null and pending; a title is stored and not pending", async () => {
	const untitled = "untitled-create";
	const titled = "titled-create";
	expect((await create({ requestId: untitled, model: model(), rulePreset: "ask", message: "hi" })).status).toBe(201);
	expect(
		(
			await create({
				requestId: titled,
				model: model(),
				rulePreset: "ask",
				title: "A given title",
				message: "hi",
			})
		).status,
	).toBe(201);
	await runtime.waitForIdle();
	expect(await sessionRows(untitled)).toMatchObject([{ title: null, title_pending: 1 }]);
	expect(await sessionRows(titled)).toMatchObject([{ title: "A given title", title_pending: 0 }]);
});

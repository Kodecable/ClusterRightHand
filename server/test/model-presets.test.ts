import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { ModelPresetView } from "../src/agent/model-presets.ts";
import { ModelConfig, type ModelRef } from "../src/agent/models.ts";
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

const faux = fauxProvider({ models: [{ id: "reviewer", reasoning: true }, { id: "plain" }] });
const ref = (modelId = "reviewer"): ModelRef => ({ provider: faux.provider.id, modelId });

let db: Db;
let app: App;
let audit: Audit;
let cluster: Cluster;
let runtime: AgentRuntime;
let admin = "";
let member = "";

const get = (cookie = admin) => call(app, "/api/model-presets", { cookie });
const put = (kind: string, body: unknown, cookie = admin) =>
	call(app, `/api/model-presets/${kind}`, { method: "PUT", cookie, body });
const list = async (cookie = admin): Promise<ModelPresetView[]> =>
	((await (await get(cookie)).json()) as { presets: ModelPresetView[] }).presets;
const preset = async (kind: string): Promise<ModelPresetView> =>
	(await list()).find((p) => p.kind === kind) as ModelPresetView;
const auditOf = async () => {
	await audit.flush();
	const r = await call(app, "/api/audit?action=settings.model_preset", { cookie: admin });
	return ((await r.json()) as { items: { detail: Record<string, unknown> }[] }).items;
};

beforeAll(async () => {
	db = await openTestDb("sqlite");
	audit = new Audit(db);
	cluster = new Cluster(db, { audit });
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
	app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models } });
	await createUser(db, { username: "root", kind: "admin", password: "password-123" });
	await createUser(db, { username: "mem", kind: "member", password: "password-123" });
	admin = await login(app, "root", "password-123");
	member = await login(app, "mem", "password-123");
});

afterAll(async () => {
	await runtime.close();
	await cluster.close();
	await db.destroy();
});

it("is for administrators only", async () => {
	expect((await get(member)).status).toBe(403);
	expect((await put("session", { systemPrompt: "hi" }, member)).status).toBe(403);
});

it("lists all three presets with their fixed default prompt and protocol", async () => {
	const presets = await list();
	expect(presets.map((p) => p.kind)).toEqual(["session", "review", "title"]);
	for (const p of presets) {
		expect(p.model).toBeNull();
		expect(p.systemPrompt).toBeNull();
		expect(p.defaultPrompt.length).toBeGreaterThan(0);
		expect(p.protocol.length).toBeGreaterThan(0);
	}
	const session = await preset("session");
	expect(session.defaultPrompt).toContain("You are ClusterRightHand");
	expect(session.protocol).toContain("list_nodes");
	const review = await preset("review");
	expect(review.defaultPrompt).not.toContain("JSON");
	expect(review.protocol).toContain("submit_review");
	const title = await preset("title");
	expect(title.defaultPrompt).toContain("title");
	expect(title.protocol).toContain("at most 60 characters");
});

it("rejects a session model, unknown kinds and unconfigured or unsupported review models", async () => {
	expect((await put("session", { model: ref() })).status).toBe(400);
	expect((await put("mystery", {})).status).toBe(400);
	expect((await put("review", { model: { provider: "nope", modelId: "m" } })).status).toBe(400);
	// The faux provider's plain model has no thinking levels besides off.
	expect((await put("review", { model: { ...ref("plain"), thinkingLevel: "high" } })).status).toBe(400);
	expect((await put("review", ["not", "an", "object"])).status).toBe(400);
});

it("rejects a preset thinking level: it belongs in the model ref", async () => {
	for (const kind of ["session", "review", "title"]) {
		const res = await put(kind, { thinkingLevel: "medium" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("thinkingLevel belongs in model");
	}
	expect((await put("review", { thinkingLevel: null })).status).toBe(400);
});

it("saves a review model with a thinking level and a custom prompt", async () => {
	const res = await put("review", { model: { ...ref(), thinkingLevel: "high" }, systemPrompt: "  Be careful.  " });
	expect(res.status).toBe(200);
	const saved = ((await res.json()) as { preset: ModelPresetView }).preset;
	expect(saved).toMatchObject({
		kind: "review",
		model: { provider: faux.provider.id, modelId: "reviewer", thinkingLevel: "high" },
		systemPrompt: "Be careful.",
	});
	// The cache is refreshed: the next read sees it too.
	expect((await preset("review")).model).toEqual(saved.model);
	const [event] = await auditOf();
	expect(event?.detail).toEqual({
		kind: "review",
		model: { provider: faux.provider.id, modelId: "reviewer", thinkingLevel: "high" },
		system_prompt_chars: "Be careful.".length,
	});
});

it("keeps omitted fields and clears with null, treating whitespace as empty", async () => {
	// The prompt is omitted: the model stays, the prompt becomes empty.
	await put("review", { systemPrompt: "   " });
	expect(await preset("review")).toMatchObject({
		model: { provider: faux.provider.id, modelId: "reviewer", thinkingLevel: "high" },
		systemPrompt: null,
	});
	// Only the prompt changes: the model stays as it was.
	await put("review", { systemPrompt: "Second look." });
	expect(await preset("review")).toMatchObject({
		model: { provider: faux.provider.id, modelId: "reviewer", thinkingLevel: "high" },
		systemPrompt: "Second look.",
	});
	await put("review", { model: null });
	expect(await preset("review")).toMatchObject({ model: null, systemPrompt: "Second look." });
});

it("stores a session prompt without a model and title models at their level", async () => {
	const session = (
		(await (await put("session", { systemPrompt: "Speak plainly." })).json()) as {
			preset: ModelPresetView;
		}
	).preset;
	expect(session).toMatchObject({ kind: "session", model: null, systemPrompt: "Speak plainly." });
	expect(session.defaultPrompt).toContain("You are ClusterRightHand");

	// An explicit level is stored; an absent one resolves to off and is omitted.
	const title = ((await (await put("title", { model: ref() })).json()) as { preset: ModelPresetView }).preset;
	expect(title.model).toEqual({ provider: faux.provider.id, modelId: "reviewer" });
	const raised = (
		(await (await put("title", { model: { ...ref(), thinkingLevel: "low" } })).json()) as {
			preset: ModelPresetView;
		}
	).preset;
	expect(raised.model).toEqual({ provider: faux.provider.id, modelId: "reviewer", thinkingLevel: "low" });

	const events = await auditOf();
	expect(events.length).toBeGreaterThanOrEqual(4);
	expect(events.map((event) => event.detail.kind)).toContain("title");
});

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
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const KEY = "sk-super-secret-key-1234567890";

describeBackends("model providers api", (backend) => {
	let db: Db;
	let app: App;
	let audit: Audit;
	let cluster: Cluster;
	let runtime: AgentRuntime;
	let admin = "";
	let member = "";

	const put = (id: string, body: unknown, cookie = admin) =>
		call(app, `/api/model-providers/${id}`, { method: "PUT", cookie, body });
	const providers = async () =>
		(await (await call(app, "/api/model-providers", { cookie: admin })).json()) as {
			providers: { providerId: string; hasApiKey: boolean; enabled: boolean; kind: string }[];
			builtin: string[];
		};
	const modelList = async (cookie = admin) =>
		((await (await call(app, "/api/models", { cookie })).json()) as { models: { provider: string; modelId: string }[] })
			.models;
	const secretRows = () => db.selectFrom("secrets").selectAll().where("kind", "=", "model_api_key").execute();
	const auditOf = async (action: string) => {
		await audit.flush();
		const r = await call(app, `/api/audit?action=${action}`, { cookie: admin });
		return ((await r.json()) as { events: { targetId: string; detail: Record<string, unknown> }[] }).events;
	};
	const proxy = (extra: Record<string, unknown> = {}) => ({
		kind: "openai-compatible",
		name: "My proxy",
		baseUrl: "http://127.0.0.1:9/v1",
		models: [{ id: "m-1", contextWindow: 32768, maxTokens: 4096 }],
		...extra,
	});

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		const masterKey = MasterKey.generate();
		const models = new ModelConfig(db, masterKey);
		await models.reload();
		runtime = await AgentRuntime.open({
			db,
			storage: new MemoryStorage(),
			models,
			cluster,
			groups: new TaskGroups(db, cluster, { audit }),
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
		cluster.close();
		await db.destroy();
	});

	it("is for administrators only", async () => {
		expect((await call(app, "/api/model-providers", { cookie: member })).status).toBe(403);
		expect((await put("deepseek", { kind: "builtin", apiKey: KEY }, member)).status).toBe(403);
		expect(
			(await call(app, "/api/model-providers/deepseek", { method: "DELETE", cookie: member, body: {} })).status,
		).toBe(403);
		expect((await providers()).providers).toEqual([]);
		// Members may list the models they can pick.
		expect((await call(app, "/api/models", { cookie: member })).status).toBe(200);
	});

	it("a builtin provider with a key: listed, never leaks the key, adds its models", async () => {
		const before = await modelList();
		expect(before.some((m) => m.provider === "deepseek")).toBe(false);
		const res = await put("deepseek", { kind: "builtin", apiKey: KEY });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(KEY);
		expect(JSON.parse(text).provider).toMatchObject({
			providerId: "deepseek",
			kind: "builtin",
			hasApiKey: true,
			enabled: true,
		});
		const listRes = await call(app, "/api/model-providers", { cookie: admin });
		const listText = await listRes.text();
		expect(listText).not.toContain(KEY);
		const list = JSON.parse(listText);
		expect(list.providers.find((p: { providerId: string }) => p.providerId === "deepseek").hasApiKey).toBe(true);
		expect(list.builtin).toContain("deepseek");
		const modelsText = await (await call(app, "/api/models", { cookie: admin })).text();
		expect(modelsText).not.toContain(KEY);
		expect((await modelList()).some((m) => m.provider === "deepseek")).toBe(true);
	});

	it("rejects an unknown builtin provider and a bad kind or id", async () => {
		expect((await put("nope-ai", { kind: "builtin" })).status).toBe(400);
		expect((await put("Bad_Id", { kind: "builtin" })).status).toBe(400);
		expect((await put("x", { kind: "mystery" })).status).toBe(400);
		expect((await put("x", {})).status).toBe(400);
		expect(
			(await call(app, "/api/model-providers/never-was", { method: "DELETE", cookie: admin, body: {} })).status,
		).toBe(404);
	});

	it("the stored key is encrypted", async () => {
		const rows = await secretRows();
		expect(rows).toHaveLength(1);
		const ct = String(rows[0]?.ciphertext);
		expect(ct).not.toContain(KEY);
		expect(Buffer.from(ct, "base64").toString("latin1")).not.toContain(KEY);
		expect(Buffer.from(ct, "base64url").toString("latin1")).not.toContain(KEY);
	});

	it("an openai-compatible provider offers its models", async () => {
		const res = await put("my-proxy", proxy({ apiKey: "proxy-key-xyz" }));
		expect(res.status).toBe(200);
		expect(((await res.json()) as { provider: unknown }).provider).toMatchObject({
			providerId: "my-proxy",
			kind: "openai-compatible",
			name: "My proxy",
			baseUrl: "http://127.0.0.1:9/v1",
			hasApiKey: true,
			models: [{ id: "m-1", contextWindow: 32768, maxTokens: 4096 }],
		});
		expect(await modelList()).toContainEqual(expect.objectContaining({ provider: "my-proxy", modelId: "m-1" }));
	});

	it("validates openai-compatible providers", async () => {
		const bad = [
			proxy({ baseUrl: undefined }),
			proxy({ baseUrl: "ftp://x" }),
			proxy({ models: [] }),
			proxy({ models: undefined }),
			proxy({ models: [{ id: "a", contextWindow: 10, maxTokens: 5 }] }),
			proxy({ models: [{ id: "a", contextWindow: 4096.5, maxTokens: 5 }] }),
			proxy({ models: [{ id: "a", contextWindow: 4096, maxTokens: 0 }] }),
			proxy({ models: [{ contextWindow: 4096, maxTokens: 5 }] }),
		];
		for (const body of bad) expect((await put("bad-proxy", body)).status).toBe(400);
		expect((await providers()).providers.map((p) => p.providerId)).not.toContain("bad-proxy");
	});

	it("apiKey null removes the key and its secret; omitting it keeps the key", async () => {
		expect(await secretRows()).toHaveLength(2);
		await put("my-proxy", proxy({ name: "Renamed" }));
		expect((await providers()).providers.find((p) => p.providerId === "my-proxy")?.hasApiKey).toBe(true);
		expect(await secretRows()).toHaveLength(2);
		const res = await put("my-proxy", proxy({ apiKey: null }));
		expect(((await res.json()) as { provider: { hasApiKey: boolean } }).provider.hasApiKey).toBe(false);
		expect(await secretRows()).toHaveLength(1);
	});

	it("replacing a key keeps one secret row", async () => {
		await put("deepseek", { kind: "builtin", apiKey: "another-key-value" });
		const rows = await secretRows();
		expect(rows).toHaveLength(1);
		expect(String(rows[0]?.ciphertext)).not.toContain("another-key-value");
	});

	it("enabled false hides the models", async () => {
		expect((await put("my-proxy", proxy({ enabled: false }))).status).toBe(200);
		expect((await providers()).providers.find((p) => p.providerId === "my-proxy")?.enabled).toBe(false);
		expect((await modelList()).some((m) => m.provider === "my-proxy")).toBe(false);
		await put("my-proxy", proxy({ enabled: true }));
		expect((await modelList()).some((m) => m.provider === "my-proxy")).toBe(true);
	});

	it("a session cannot use a model of a disabled or deleted provider", async () => {
		const mk = () =>
			call(app, "/api/sessions", { cookie: admin, body: { model: { provider: "my-proxy", modelId: "m-1" } } });
		expect((await mk()).status).toBe(201);
		await put("my-proxy", proxy({ enabled: false }));
		expect((await mk()).status).toBe(400);
	});

	it("delete removes the provider, its secret and its models", async () => {
		await put("my-proxy", proxy({ apiKey: "k2-secret", enabled: true }));
		const secrets = (await secretRows()).length;
		expect(
			(await call(app, "/api/model-providers/my-proxy", { method: "DELETE", cookie: admin, body: {} })).status,
		).toBe(200);
		expect((await providers()).providers.map((p) => p.providerId)).not.toContain("my-proxy");
		expect(await secretRows()).toHaveLength(secrets - 1);
		expect((await modelList()).some((m) => m.provider === "my-proxy")).toBe(false);
		expect(
			(await call(app, "/api/model-providers/my-proxy", { method: "DELETE", cookie: admin, body: {} })).status,
		).toBe(404);
		expect(
			(await call(app, "/api/model-providers/deepseek", { method: "DELETE", cookie: admin, body: {} })).status,
		).toBe(200);
		expect(await secretRows()).toHaveLength(0);
	});

	it("audits saves and deletes without the key", async () => {
		const saved = await auditOf("model_provider.saved");
		expect(saved.length).toBeGreaterThanOrEqual(3);
		const first = saved.find((e) => e.targetId === "deepseek");
		expect(first?.detail).toMatchObject({ kind: "builtin", api_key_set: true, enabled: true });
		const dump = JSON.stringify(saved);
		for (const secret of [KEY, "another-key-value", "proxy-key-xyz", "k2-secret"]) expect(dump).not.toContain(secret);
		expect((await auditOf("model_provider.deleted")).map((e) => e.targetId)).toContain("my-proxy");
	});
});

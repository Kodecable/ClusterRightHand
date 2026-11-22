import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ModelCatalogue } from "../src/agent/model-catalogue.ts";
import { ModelConfig } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { CallRunner } from "../src/extensions/call-runner.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { BadGatewayError } from "../src/util/errors.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const KEY = "sk-discovery-secret-1234567890";
const BASE_URL = "https://llm.example/v1";

/** A small hand-written models.dev catalogue for the fill. */
const FIXTURE = {
	gateway: {
		name: "Gateway",
		api: BASE_URL,
		models: {
			"gateway-a": {
				id: "gateway-a",
				name: "Gateway A",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "high"] }],
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 128_000, output: 16_384 },
			},
		},
	},
};

describeBackends("model discovery api", (backend) => {
	let db: Db;
	let app: App;
	let audit: Audit;
	let cluster: Cluster;
	let runtime: AgentRuntime;
	let models: ModelConfig;
	let dir: string;
	let admin = "";
	let member = "";
	let upstream: { status: number; body: unknown } = { status: 200, body: { data: [] } };
	const requests: { url: string; headers: Headers }[] = [];

	const provider = () => `/api/model-providers/my-gateway`;
	const discover = (cookie = admin) => call(app, `${provider()}/discover`, { cookie });
	const add = (ids: string[], cookie = admin) =>
		call(app, `${provider()}/discover`, { method: "POST", cookie, body: { ids } });
	const providerView = async () =>
		(
			(await (await call(app, "/api/model-providers", { cookie: admin })).json()) as {
				providers: { providerId: string; models: { id: string }[] | null; hasApiKey: boolean }[];
			}
		).providers.find((candidate) => candidate.providerId === "my-gateway");
	const auditOf = async (action: string) => {
		await audit.flush();
		const response = await call(app, `/api/audit?action=${action}`, { cookie: admin });
		return ((await response.json()) as { items: { targetId: string; detail: Record<string, unknown> }[] }).items;
	};

	beforeAll(async () => {
		db = await openTestDb(backend);
		audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		const masterKey = MasterKey.generate();
		models = new ModelConfig(db, masterKey);
		await models.reload();
		dir = await mkdtemp(join(tmpdir(), "crhs-discovery-"));
		const catalogueDir = join(dir, "models-dev");
		await mkdir(catalogueDir, { recursive: true });
		await writeFile(join(catalogueDir, "api.json"), JSON.stringify(FIXTURE));
		const catalogue = new ModelCatalogue({
			stateDir: dir,
			download: false,
			fetch: (async (input: string | URL, init?: RequestInit) => {
				requests.push({ url: String(input), headers: new Headers(init?.headers) });
				return new Response(typeof upstream.body === "string" ? upstream.body : JSON.stringify(upstream.body), {
					status: upstream.status,
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch,
		});
		runtime = await AgentRuntime.open({
			callRunner: new CallRunner(),
			db,
			storage: new MemoryStorage(),
			models,
			cluster,
			taskGroups: new TaskGroups(db, cluster, { audit }),
			audit,
		});
		app = makeApp(db, undefined, {
			cluster,
			audit,
			masterKey,
			agent: { runtime, models },
			modelCatalogue: catalogue,
		});
		await createUser(db, { username: "root", kind: "admin", password: "password-123" });
		await createUser(db, { username: "mem", kind: "member", password: "password-123" });
		admin = await login(app, "root", "password-123");
		member = await login(app, "mem", "password-123");
	});

	afterAll(async () => {
		await runtime.close();
		await cluster.close();
		await db.destroy();
		await rm(dir, { recursive: true, force: true });
	});

	beforeEach(() => {
		requests.length = 0;
		upstream = {
			status: 200,
			body: { data: [{ id: "gateway-a" }, { id: "gateway-b" }, { id: "gateway-b" }, { id: "m-1" }] },
		};
	});

	it("is for administrators only", async () => {
		expect((await discover(member)).status).toBe(403);
		expect((await add(["gateway-a"], member)).status).toBe(403);
	});

	it("lists only unconfigured ids, sending the stored key and the provider headers server-side", async () => {
		const saved = await call(app, provider(), {
			method: "PUT",
			cookie: admin,
			body: {
				kind: "custom",
				name: "My Gateway",
				baseUrl: BASE_URL,
				apiKey: KEY,
				headers: { "x-gateway": "edge" },
				models: [{ id: "m-1", api: "openai-completions", input: ["text"], contextWindow: 32768, maxTokens: 4096 }],
			},
		});
		expect(saved.status).toBe(200);

		const response = await discover();
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual({ models: ["gateway-a", "gateway-b"] });
		expect(text).not.toContain(KEY);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(`${BASE_URL}/models`);
		expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(requests[0]?.headers.get("x-gateway")).toBe("edge");
		expect(requests[0]?.headers.get("accept")).toBe("application/json");
	});

	it("maps upstream failures to a 502 with a message the dialog can show", async () => {
		upstream = { status: 401, body: { error: "bad key" } };
		let response = await discover();
		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: string }).error).toMatch(/answered 401/);

		upstream = { status: 200, body: "not json" };
		response = await discover();
		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: string }).error).toMatch(/did not return JSON/);

		upstream = { status: 200, body: { models: [] } };
		response = await discover();
		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: string }).error).toMatch(/"data" list/);

		upstream = { status: 200, body: { data: [{ name: "no id" }] } };
		response = await discover();
		expect(response.status).toBe(502);
		expect(((await response.json()) as { error: string }).error).toMatch(/no model ids/);
	});

	it("adds the selected ids, filled from the catalogue, and audits them", async () => {
		const response = await add(["gateway-a", "gateway-b"]);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			provider: {
				models: {
					id: string;
					name?: string;
					api: string;
					contextWindow: number;
					maxTokens: number;
					input: string[];
					thinking?: { mode: string; levels: Record<string, string> };
				}[];
				hasApiKey: boolean;
			};
		};
		expect(body.provider.hasApiKey).toBe(true);
		expect(body.provider.models).toEqual([
			{ id: "m-1", api: "openai-completions", contextWindow: 32768, maxTokens: 4096, input: ["text"] },
			{
				id: "gateway-a",
				name: "Gateway A",
				api: "openai-completions",
				contextWindow: 128_000,
				maxTokens: 16_384,
				input: ["text", "image"],
				thinking: { mode: "standard", levels: { low: "low", high: "high" } },
			},
			{ id: "gateway-b", api: "openai-completions", contextWindow: 32768, maxTokens: 4096, input: ["text"] },
		]);
		// The same persistence path: the stored key, headers and session fields are untouched.
		expect((await providerView())?.hasApiKey).toBe(true);
		const row = await db
			.selectFrom("model_providers")
			.selectAll()
			.where("provider_id", "=", "my-gateway")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(row.models as string).map((model: { id: string }) => model.id)).toEqual([
			"m-1",
			"gateway-a",
			"gateway-b",
		]);
		expect(JSON.parse(row.headers as string)).toEqual({ "x-gateway": "edge" });

		const available = (
			(await (await call(app, "/api/models", { cookie: admin })).json()) as {
				models: { provider: string; modelId: string }[];
			}
		).models;
		expect(available).toContainEqual(expect.objectContaining({ provider: "my-gateway", modelId: "gateway-a" }));

		const events = (await auditOf("model_provider.saved")).filter((event) => event.targetId === "my-gateway");
		expect(
			events.some((event) => JSON.stringify(event.detail.added_models) === JSON.stringify(["gateway-a", "gateway-b"])),
		).toBe(true);
		expect(JSON.stringify(events)).not.toContain(KEY);

		// The listed ids are now configured, so they are gone from the next listing.
		upstream = { status: 200, body: { data: [{ id: "gateway-a" }, { id: "gateway-b" }, { id: "gateway-c" }] } };
		expect(JSON.parse(await (await discover()).text())).toEqual({ models: ["gateway-c"] });
	});

	it("rejects ids that are empty, repeated or configured already", async () => {
		let response = await add(["m-1"]);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/already configured/);

		response = await add(["gateway-c", "gateway-c"]);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/listed twice/);

		response = await call(app, `${provider()}/discover`, { method: "POST", cookie: admin, body: { ids: [""] } });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/must not be empty/);

		response = await call(app, `${provider()}/discover`, { method: "POST", cookie: admin, body: { ids: [] } });
		expect(response.status).toBe(400);
	});

	it("rejects built-in providers and unknown providers", async () => {
		const builtin = await call(app, "/api/model-providers/deepseek", {
			method: "PUT",
			cookie: admin,
			body: { kind: "builtin", apiKey: KEY },
		});
		expect(builtin.status).toBe(200);
		let response = await call(app, "/api/model-providers/deepseek/discover", { cookie: admin });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toMatch(/only a custom provider/);
		response = await call(app, "/api/model-providers/never-was/discover", { cookie: admin });
		expect(response.status).toBe(404);
	});

	it("reports a timeout and an unreachable provider as upstream failures", async () => {
		const timeout = new ModelCatalogue({
			download: false,
			fetch: (async () => {
				throw new DOMException("timed out", "TimeoutError");
			}) as typeof fetch,
		});
		await expect(timeout.discover(BASE_URL, KEY, undefined)).rejects.toThrow(/did not answer within 15 s/);
		const unreachable = new ModelCatalogue({
			download: false,
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as typeof fetch,
		});
		await expect(unreachable.discover(BASE_URL, KEY, undefined)).rejects.toBeInstanceOf(BadGatewayError);
	});
});

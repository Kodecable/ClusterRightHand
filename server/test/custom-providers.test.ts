import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { type CustomModel, ModelConfig, saveModelProvider } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, UserError } from "../src/users/service.ts";
import { waitFor } from "./helpers/agent.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

const KEY = "sk-custom-test";

interface Recorded {
	url: string;
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

/** A minimal OpenAI-compatible endpoint: both Chat Completions and Responses stream one text answer. */
function startStub(): Promise<{ server: Server; url: string; requests: Recorded[] }> {
	const requests: Recorded[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			} catch {
				body = { raw };
			}
			requests.push({ url: req.url ?? "", headers: req.headers, body });
			const path = req.url ?? "";
			if (path.endsWith("/chat/completions")) {
				res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
				const chunk = (delta: Record<string, unknown>, finish: string | null) =>
					`data: ${JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion.chunk",
						created: 1,
						model: "m-1",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`;
				res.write(chunk({ role: "assistant", content: "ok" }, null));
				res.write(chunk({}, "stop"));
				res.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-1",
						object: "chat.completion.chunk",
						created: 1,
						model: "m-1",
						choices: [],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					})}\n\n`,
				);
				res.end("data: [DONE]\n\n");
				return;
			}
			if (path.endsWith("/responses")) {
				res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
				const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
				send({
					type: "response.output_item.added",
					output_index: 0,
					item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
				});
				send({ type: "response.output_text.delta", output_index: 0, delta: "ok" });
				send({
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						output: [
							{
								id: "msg_1",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "ok", annotations: [] }],
							},
						],
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				});
				res.end();
				return;
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "not found" } }));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests });
		});
	});
}

describeBackends("custom model providers", (backend) => {
	let db: Db;
	let masterKey: MasterKey;
	let models: ModelConfig;
	let stub: { server: Server; url: string; requests: Recorded[] };
	let counter = 0;

	const configure = async (customModels: CustomModel[], extra: Record<string, unknown> = {}) => {
		const providerId = `p-${++counter}`;
		await saveModelProvider(db, masterKey, {
			kind: "custom",
			providerId,
			name: providerId,
			baseUrl: stub.url,
			apiKey: KEY,
			models: customModels,
			...extra,
		});
		await models.reload();
		return providerId;
	};

	const ask = async (
		providerId: string,
		modelId = "m-1",
		options: {
			sessionId?: string;
			reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		} = {},
	) => {
		const model = models.models.getModel(providerId, modelId);
		expect(model).toBeDefined();
		// pi-ai's simple options spell "off" as no level at all, like durable's requests.
		const { reasoning, ...rest } = options;
		await models.models.completeSimple(
			model as NonNullable<typeof model>,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ ...rest, ...(reasoning && reasoning !== "off" ? { reasoning } : {}) },
		);
		return stub.requests.at(-1) as Recorded;
	};

	const lastBody = () => (stub.requests.at(-1) as Recorded).body;

	beforeAll(async () => {
		db = await openTestDb(backend);
		masterKey = MasterKey.generate();
		models = new ModelConfig(db, masterKey);
		models.setSessionResolver(
			(providerSessionId) => (providerSessionId === "provider-1" ? "crh-session-1" : undefined),
			(sessionId) => (sessionId === "crh-session-1" ? "provider-1" : undefined),
		);
		await models.reload();
		stub = await startStub();
	});

	afterAll(async () => {
		await new Promise((resolve) => stub.server.close(resolve));
		await db.destroy();
	});

	beforeEach(() => {
		stub.requests.length = 0;
	});

	it("standard mode: pi-ai maps the level and applies the format to Chat Completions", async () => {
		const provider = await configure([
			{
				id: "m-1",
				api: "openai-completions",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text"],
				thinking: { mode: "standard", format: "openai", levels: { high: "ultra" } },
			},
		]);
		await ask(provider, "m-1", { reasoning: "high" });
		expect(lastBody().reasoning_effort).toBe("ultra");
		const model = models.models.getModel(provider, "m-1");
		expect(model && getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("standard mode: Responses sends reasoning.effort", async () => {
		const provider = await configure([
			{
				id: "m-1",
				api: "openai-responses",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text"],
				thinking: { mode: "standard", levels: { high: "high" } },
			},
		]);
		await ask(provider, "m-1", { reasoning: "high" });
		expect(lastBody().reasoning).toEqual({ effort: "high", summary: "auto" });
	});

	it("standard mode: labels rename levels and an empty label hides one", async () => {
		const provider = await configure([
			{
				id: "m-1",
				api: "openai-completions",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text"],
				thinking: {
					mode: "standard",
					levels: { high: "ultra" },
					labels: { off: "None", high: "", xhigh: "Extreme" },
				},
			},
		]);
		const model = models.models.getModel(provider, "m-1");
		// `high` is hidden by its empty label; `xhigh` is offered by its non-empty name and sends its id.
		expect(model && getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "xhigh"]);
		expect(model?.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(models.available().find((m) => m.provider === provider)?.thinkingLabels).toEqual({
			off: "None",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			xhigh: "Extreme",
		});
		expect(() => models.resolveRef({ provider, modelId: "m-1", thinkingLevel: "high" })).toThrow(
			/thinking level high is not supported/,
		);
	});

	it("custom mode: a level is offered only with a body and a non-empty display name", async () => {
		const provider = await configure([
			{
				id: "m-1",
				api: "openai-completions",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text"],
				thinking: {
					mode: "custom",
					levels: {
						medium: { thinking: { type: "enabled", budget_tokens: 4000 } },
						high: { thinking: { type: "enabled", budget_tokens: 8000 } },
					},
					// `medium` has a body but no display name, `low` has a name but no body.
					labels: { medium: "", low: "Low" },
				},
			},
		]);
		const model = models.models.getModel(provider, "m-1");
		expect(model && getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
		expect(models.available().find((m) => m.provider === provider)?.thinkingLabels).toEqual({
			off: "off",
			high: "high",
		});
	});

	it("rejects invalid display names and a hidden off level", async () => {
		for (const [labels, pattern] of [
			[{ off: "" }, /labels\.off: off cannot be hidden/],
			[{ high: 3 }, /labels\.high: expected a string/],
			[{ turbo: "x" }, /labels\.turbo: unknown thinking level/],
		] as const) {
			await expect(
				saveModelProvider(db, masterKey, {
					kind: "custom",
					providerId: "bad-labels",
					baseUrl: stub.url,
					models: [
						{
							id: "m-1",
							api: "openai-completions",
							contextWindow: 4096,
							maxTokens: 512,
							input: ["text"],
							thinking: { mode: "standard", levels: {}, labels },
						},
					],
				}),
			).rejects.toThrow(pattern);
		}
	});

	it("custom mode: Chat Completions merges the level and sends no pi thinking params", async () => {
		const provider = await configure([
			{
				id: "m-1",
				api: "openai-completions",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text"],
				thinking: {
					mode: "custom",
					levels: {
						off: { thinking: { type: "disabled" } },
						high: { thinking: { type: "enabled", budget_tokens: 16000 }, metadata: { nested: { a: 1 } } },
					},
				},
			},
		]);
		await ask(provider, "m-1", { reasoning: "high" });
		const body = lastBody();
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
		expect(body.metadata).toEqual({ nested: { a: 1 } });
		expect(body).not.toHaveProperty("reasoning_effort");
		expect(body).not.toHaveProperty("enable_thinking");
		expect(body).not.toHaveProperty("chat_template_kwargs");
		const model = models.models.getModel(provider, "m-1");
		expect(model && getSupportedThinkingLevels(model)).toEqual(["off", "high"]);

		// `off` listed: its body is merged too, still without any pi thinking parameter.
		await ask(provider, "m-1", { reasoning: "off" });
		expect(lastBody().thinking).toEqual({ type: "disabled" });
		expect(lastBody()).not.toHaveProperty("reasoning_effort");
	});

	it("custom mode: Responses merges the level and strips reasoning/include", async () => {
		const provider = await configure([
			{
				id: "m-1",
				api: "openai-responses",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text"],
				thinking: {
					mode: "custom",
					levels: { high: { thinking: { type: "enabled", budget_tokens: 8000 } } },
				},
			},
		]);
		await ask(provider, "m-1", { reasoning: "high" });
		const body = lastBody();
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
		expect(body).not.toHaveProperty("reasoning");
		expect(body).not.toHaveProperty("include");
		const model = models.models.getModel(provider, "m-1");
		expect(model && getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
	});

	it("custom mode: off is available and merges nothing when it is not listed", async () => {
		const provider = await configure([
			{
				id: "m-1",
				api: "openai-completions",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text"],
				thinking: { mode: "custom", levels: { high: { thinking: { type: "enabled" } } } },
			},
		]);
		const model = models.models.getModel(provider, "m-1");
		expect(model && getSupportedThinkingLevels(model)).toEqual(["off", "high"]);
		await ask(provider, "m-1", { reasoning: "off" });
		expect(lastBody()).not.toHaveProperty("thinking");
		expect(lastBody()).not.toHaveProperty("reasoning_effort");
	});

	it("custom mode: Responses at off with no off entry still strips pi's reasoning", async () => {
		const provider = await configure([
			{
				id: "m-1",
				api: "openai-responses",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text"],
				thinking: { mode: "custom", levels: { high: { thinking: { type: "enabled" } } } },
			},
		]);
		await ask(provider, "m-1", { reasoning: "off" });
		expect(lastBody()).not.toHaveProperty("reasoning");
		expect(lastBody()).not.toHaveProperty("include");
		expect(lastBody()).not.toHaveProperty("thinking");
	});

	it("no thinking: only off, and reasoning false", async () => {
		const provider = await configure([
			{ id: "m-1", api: "openai-completions", contextWindow: 4096, maxTokens: 512, input: ["text"] },
		]);
		const model = models.models.getModel(provider, "m-1");
		expect(model?.reasoning).toBe(false);
		expect(model && getSupportedThinkingLevels(model)).toEqual(["off"]);
		await ask(provider, "m-1");
		expect(lastBody()).not.toHaveProperty("reasoning_effort");
	});

	it("session id fields, extra headers and image input", async () => {
		const provider = await configure(
			[
				{
					id: "m-1",
					api: "openai-completions",
					contextWindow: 4096,
					maxTokens: 512,
					input: ["text", "image"],
				},
			],
			{ headers: { "x-extra": "yes" }, sessionId: { headers: ["x-crh-session"], body: ["metadata.session_id"] } },
		);
		expect(models.models.getModel(provider, "m-1")?.input).toEqual(["text", "image"]);
		const request = await ask(provider, "m-1", { sessionId: "provider-1" });
		expect(request.headers["x-crh-session"]).toBe("crh-session-1");
		expect(request.headers["x-extra"]).toBe("yes");
		expect(request.body.metadata).toEqual({ session_id: "crh-session-1" });
	});

	it("an unresolved provider session id omits the session fields", async () => {
		const provider = await configure(
			[
				{
					id: "m-1",
					api: "openai-completions",
					contextWindow: 4096,
					maxTokens: 512,
					input: ["text"],
				},
			],
			{ sessionId: { headers: ["x-crh-session"], body: ["metadata.session_id"] } },
		);
		const request = await ask(provider, "m-1", { sessionId: "provider-unknown" });
		expect(request.headers["x-crh-session"]).toBeUndefined();
		expect(request.body.metadata).toBeUndefined();
	});

	it("a Responses body-mode session id is deep-set as well", async () => {
		const provider = await configure(
			[
				{
					id: "m-1",
					api: "openai-responses",
					contextWindow: 4096,
					maxTokens: 512,
					input: ["text"],
				},
			],
			{ sessionId: { body: ["metadata.session_id"] } },
		);
		const request = await ask(provider, "m-1", { sessionId: "provider-1" });
		expect(request.body.metadata).toEqual({ session_id: "crh-session-1" });
	});

	it("validates compat with a named field path", async () => {
		const base = (compat: unknown, api: "openai-completions" | "openai-responses" = "openai-completions") => ({
			kind: "custom" as const,
			providerId: "bad",
			baseUrl: stub.url,
			models: [{ id: "m-1", api, contextWindow: 4096, maxTokens: 512, input: ["text"], compat }],
		});
		await expect(saveModelProvider(db, masterKey, base({ maxTokensField: "nope" }))).rejects.toThrow(
			/models\[0\]\.compat\.maxTokensField/,
		);
		await expect(
			saveModelProvider(db, masterKey, base({ supportsDeveloperRole: "yes" }, "openai-responses")),
		).rejects.toThrow(/models\[0\]\.compat\.supportsDeveloperRole/);
		await expect(saveModelProvider(db, masterKey, base("nope"))).rejects.toThrow(/models\[0\]\.compat/);
	});

	it("validates thinking, models, session fields and kinds", async () => {
		const provider = (extra: Record<string, unknown>) => ({
			kind: "custom" as const,
			providerId: "bad",
			baseUrl: stub.url,
			models: [
				{ id: "m-1", api: "openai-completions", contextWindow: 4096, maxTokens: 512, input: ["text"], ...extra },
			],
		});
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ thinking: { mode: "standard", levels: { turbo: "x" } } }, /thinking\.levels\.turbo/],
			[{ thinking: { mode: "standard", levels: { high: 3 } } }, /thinking\.levels\.high/],
			[{ api: "azure-openai-responses" }, /api/],
			[{ api: "openai-responses", thinking: { mode: "standard", format: "openai", levels: {} } }, /thinking\.format/],
			[{ thinking: { mode: "custom", format: "openai", levels: {} } }, /thinking\.format/],
			[{ thinking: { mode: "custom", levels: { high: "x" } } }, /thinking\.levels\.high/],
			[{ input: ["image"] }, /input/],
			[{ contextWindow: 1023 }, /contextWindow/],
			[{ maxTokens: 0 }, /maxTokens/],
		];
		for (const [extra, pattern] of cases) {
			await expect(saveModelProvider(db, masterKey, provider(extra))).rejects.toThrow(pattern);
		}
		await expect(
			saveModelProvider(db, masterKey, {
				kind: "custom",
				providerId: "bad",
				baseUrl: stub.url,
				sessionId: { headers: ["bad header"] },
				models: [{ id: "m-1", api: "openai-completions", contextWindow: 4096, maxTokens: 512, input: ["text"] }],
			}),
		).rejects.toThrow(/sessionId\.headers\[0\]/);
		await expect(
			saveModelProvider(db, masterKey, {
				kind: "custom",
				providerId: "bad",
				baseUrl: stub.url,
				sessionId: { body: ["metadata.bad path"] },
				models: [{ id: "m-1", api: "openai-completions", contextWindow: 4096, maxTokens: 512, input: ["text"] }],
			}),
		).rejects.toThrow(/sessionId\.body\[0\]/);
		await expect(
			saveModelProvider(db, masterKey, {
				kind: "openai-compatible" as never,
				providerId: "bad",
				baseUrl: stub.url,
			}),
		).rejects.toThrow(/kind/);
		await expect(
			saveModelProvider(db, masterKey, { kind: "custom", providerId: "Bad", baseUrl: stub.url }),
		).rejects.toThrow(UserError);
	});

	it("the view never contains the key and lists the new fields", async () => {
		const provider = await configure(
			[
				{
					id: "m-1",
					api: "openai-responses",
					contextWindow: 4096,
					maxTokens: 512,
					input: ["text"],
					thinking: { mode: "custom", levels: { low: { a: 1 } } },
					compat: { supportsDeveloperRole: false },
				},
			],
			{ headers: { "x-extra": "yes" }, sessionId: { body: ["metadata.session_id"] } },
		);
		const view = (await models.models.getModel(provider, "m-1")) as never;
		expect(view).toBeDefined();
		const rows = await db.selectFrom("model_providers").selectAll().where("provider_id", "=", provider).execute();
		expect(rows[0]?.models).not.toContain(KEY);
		expect((JSON.parse(rows[0]?.models ?? "[]") as Record<string, unknown>[])[0]?.compat).toEqual({
			supportsDeveloperRole: false,
		});
		expect(rows[0]?.session_id).toContain("metadata.session_id");
	});
	it("the runtime resolves the provider session to the crh session before the first request", async () => {
		const runtimeDb = await openTestDb(backend);
		const audit = new Audit(runtimeDb);
		const cluster = new Cluster(runtimeDb, { audit });
		const taskGroups = new TaskGroups(runtimeDb, cluster, { audit });
		const masterKey = MasterKey.generate();
		const runtimeModels = new ModelConfig(runtimeDb, masterKey);
		await runtimeModels.reload();
		const providerId = "wire";
		await saveModelProvider(runtimeDb, masterKey, {
			kind: "custom",
			providerId,
			baseUrl: stub.url,
			models: [
				{
					id: "m-1",
					api: "openai-completions",
					contextWindow: 4096,
					maxTokens: 512,
					input: ["text"],
				},
			],
			sessionId: { headers: ["x-crh-session"], body: ["metadata.session_id"] },
		});
		await runtimeModels.reload();
		const runtime = await AgentRuntime.open({
			db: runtimeDb,
			storage: new MemoryStorage(),
			models: runtimeModels,
			cluster,
			taskGroups,
			audit,
		});
		try {
			const user = await createUser(runtimeDb, { username: "custom-wire", kind: "admin", password: "password-123" });
			const owner = { userId: user.id, username: user.username, kind: "admin" as const, sessionId: "web" };
			const session = await runtime.createSession(owner, {
				model: { provider: providerId, modelId: "m-1" },
				rulePreset: "yolo",
			});
			await runtime.submit(session.id, owner, "hello", "req-custom-wire");
			const request = await waitFor("the first generation request", () => stub.requests[0], 10_000);
			// The mapping must exist before the first request: no earlier response wrote it.
			expect(request.headers["x-crh-session"]).toBe(session.id);
			expect(request.body.metadata).toEqual({ session_id: session.id });
		} finally {
			await runtime.close();
			await cluster.close();
			await runtimeDb.destroy();
		}
	}, 30_000);
});

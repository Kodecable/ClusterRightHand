import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfig, saveModelProvider } from "../src/agent/models.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { Audit } from "../src/audit/audit.ts";
import { Cluster } from "../src/cluster/cluster.ts";
import { TaskGroups } from "../src/cluster/task-groups.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { waitFor } from "./helpers/agent.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PLAIN = "plain-model";
const THINK = "think-model";
const MODEL_ID = "m-1";

/** A minimal OpenAI-compatible endpoint, recording every request body. */
function startStub(): Promise<{ server: Server; url: string; requests: Record<string, unknown>[] }> {
	const requests: Record<string, unknown>[] = [];
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			try {
				requests.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
			} catch {
				requests.push({ raw });
			}
			res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
			const chunk = (delta: Record<string, unknown>, finish: string | null) =>
				`data: ${JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion.chunk",
					created: 1,
					model: MODEL_ID,
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			res.write(chunk({ role: "assistant", content: "ok" }, null));
			res.write(chunk({}, "stop"));
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion.chunk",
					created: 1,
					model: MODEL_ID,
					choices: [],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				})}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests });
		});
	});
}

/** One model with thinking levels off..high, one with only off (D115). */
describe("thinking levels end to end", () => {
	let db: Db;
	let app: App;
	let runtime: AgentRuntime;
	let models: ModelConfig;
	let masterKey: MasterKey;
	let cluster: Cluster;
	let stub: { server: Server; url: string; requests: Record<string, unknown>[] };
	let cookie = "";
	let sessionId = "";
	let scheduleId = "";

	const request = (path: string, init: { method?: string; body?: unknown } = {}) =>
		call(app, path, { cookie, ...init });

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		masterKey = MasterKey.generate();
		const audit = new Audit(db);
		cluster = new Cluster(db, { audit });
		models = new ModelConfig(db, masterKey);
		runtime = await AgentRuntime.open({
			db,
			storage: new MemoryStorage(),
			models,
			cluster,
			taskGroups: new TaskGroups(db, cluster, { audit }),
			audit,
		});
		stub = await startStub();
		const modelsOf = (thinking?: Record<string, unknown>) => [
			{
				id: MODEL_ID,
				api: "openai-completions",
				contextWindow: 4096,
				maxTokens: 512,
				input: ["text", "image"],
				...(thinking ? { thinking } : {}),
			},
		];
		// Two providers, because a provider's models differ: one can think, one cannot.
		await saveModelProvider(db, masterKey, {
			kind: "custom",
			providerId: THINK,
			baseUrl: stub.url,
			models: modelsOf({ mode: "format", format: "openai", levels: {} }) as never,
		});
		await saveModelProvider(db, masterKey, {
			kind: "custom",
			providerId: PLAIN,
			baseUrl: stub.url,
			models: modelsOf() as never,
		});
		await models.reload();
		const scheduler = new Scheduler({ db, runtime, audit });
		app = makeApp(db, undefined, { cluster, audit, masterKey, agent: { runtime, models }, scheduler });
		await createUser(db, { username: "thinker", kind: "admin", password: "password-123" });
		cookie = await login(app, "thinker", "password-123");
	});

	afterAll(async () => {
		await runtime.waitForIdle();
		await runtime.close();
		await cluster.close();
		await new Promise((resolve) => stub.server.close(resolve));
		await db.destroy();
	});

	it("GET /api/models lists the supported levels and input kinds", async () => {
		const res = await request("/api/models");
		expect(res.status).toBe(200);
		const { models: list } = (await res.json()) as {
			models: { provider: string; modelId: string; thinkingLevels: string[]; input: string[] }[];
		};
		const think = list.find((model) => model.provider === THINK && model.modelId === MODEL_ID);
		expect(think?.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(think?.input).toEqual(["text", "image"]);
		const plain = list.find((model) => model.provider === PLAIN && model.modelId === MODEL_ID);
		expect(plain?.thinkingLevels).toEqual(["off"]);
		expect(plain?.input).toEqual(["text", "image"]);
	});

	it("rejects an explicit level the model does not support on session create and patch", async () => {
		const unsupported = await request("/api/sessions", {
			body: { model: { provider: THINK, modelId: MODEL_ID, thinkingLevel: "xhigh" } },
		});
		expect(unsupported.status).toBe(400);
		expect(((await unsupported.json()) as { error: string }).error).toBe(
			`thinking level xhigh is not supported by ${THINK}/${MODEL_ID}; supported: off, minimal, low, medium, high`,
		);

		const created = await request("/api/sessions", {
			body: { model: { provider: THINK, modelId: MODEL_ID, thinkingLevel: "high" } },
		});
		expect(created.status).toBe(201);
		const session = ((await created.json()) as { session: { id: string; model: { thinkingLevel: string } } }).session;
		sessionId = session.id;
		expect(session.model).toEqual({ provider: THINK, modelId: MODEL_ID, thinkingLevel: "high" });

		const badPatch = await request(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: { model: { provider: THINK, modelId: MODEL_ID, thinkingLevel: "xhigh" } },
		});
		expect(badPatch.status).toBe(400);
		const view = (await (await request(`/api/sessions/${sessionId}`)).json()) as {
			session: { model: { thinkingLevel: string } };
		};
		// The failed patch changed nothing.
		expect(view.session.model.thinkingLevel).toBe("high");
	});

	it("keeps the level across model changes and clamps it to the new model", async () => {
		const patch = (model: Record<string, unknown>) =>
			request(`/api/sessions/${sessionId}`, { method: "PATCH", body: { model } });
		const level = async () =>
			(
				(await (await request(`/api/sessions/${sessionId}`)).json()) as {
					session: { model: { thinkingLevel: string } };
				}
			).session.model.thinkingLevel;
		const stored = async () =>
			(await db.selectFrom("sessions").select("model").where("id", "=", sessionId).executeTakeFirst())?.model;

		// high -> a model with only off: clamped to off, stored without a level.
		expect((await patch({ provider: PLAIN, modelId: MODEL_ID })).status).toBe(200);
		expect(await level()).toBe("off");
		expect(JSON.parse((await stored()) ?? "{}")).toEqual({ provider: PLAIN, modelId: MODEL_ID });

		// Back without a level: the previous level is off, so it stays off.
		expect((await patch({ provider: THINK, modelId: MODEL_ID })).status).toBe(200);
		expect(await level()).toBe("off");

		// An explicit level is used.
		expect((await patch({ provider: THINK, modelId: MODEL_ID, thinkingLevel: "high" })).status).toBe(200);
		expect(await level()).toBe("high");
		expect(JSON.parse((await stored()) ?? "{}")).toEqual({
			provider: THINK,
			modelId: MODEL_ID,
			thinkingLevel: "high",
		});
		// A level-only change is the same provider/model plus a level.
		expect((await patch({ provider: THINK, modelId: MODEL_ID, thinkingLevel: "low" })).status).toBe(200);
		expect(await level()).toBe("low");
	});

	it("durable configuration follows the effective level on the next request", async () => {
		await request(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: { model: { provider: THINK, modelId: MODEL_ID, thinkingLevel: "high" } },
		});
		const before = stub.requests.length;
		expect(
			(await request(`/api/sessions/${sessionId}/messages`, { body: { text: "hello", requestId: "r-1" } })).status,
		).toBe(202);
		const high = await waitFor("the high request", () => stub.requests[before], 10_000);
		expect(high.reasoning_effort).toBe("high");

		await request(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: { model: { provider: PLAIN, modelId: MODEL_ID } },
		});
		const afterPatch = stub.requests.length;
		expect(
			(
				await request(`/api/sessions/${sessionId}/messages`, {
					body: { text: "again", requestId: "r-2" },
				})
			).status,
		).toBe(202);
		const plain = await waitFor("the off request", () => stub.requests[afterPatch], 10_000);
		expect(plain).not.toHaveProperty("reasoning_effort");
		await runtime.waitForIdle();
	});

	it("rejects a subagent model with an unsupported level", async () => {
		await expect(
			runtime.createSubagent(sessionId, {
				callKey: "thinking-subagent",
				task: "do it",
				rules: { default: "inherit", rules: [] },
				quota: null,
				model: { provider: PLAIN, modelId: MODEL_ID, thinkingLevel: "high" },
			}),
		).rejects.toThrow(/thinking level high is not supported by plain-model\/m-1/);
	});

	it("validates and keeps the level on schedules", async () => {
		const base = {
			name: "thinking schedule",
			prompt: "do it",
			model: { provider: THINK, modelId: MODEL_ID, thinkingLevel: "high" },
			rulePreset: "ask",
			tokenBudget: null,
			cron: "0 9 * * *",
			timezone: "UTC",
			catchUp: false,
			enabled: false,
		};
		const bad = await request("/api/schedules", {
			body: { ...base, model: { provider: PLAIN, modelId: MODEL_ID, thinkingLevel: "high" } },
		});
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: string }).error).toContain("thinking level high is not supported");

		const created = await request("/api/schedules", { body: base });
		expect(created.status).toBe(201);
		const schedule = ((await created.json()) as { schedule: { id: string; model: { thinkingLevel: string } } })
			.schedule;
		scheduleId = schedule.id;
		expect(schedule.model).toEqual({ provider: THINK, modelId: MODEL_ID, thinkingLevel: "high" });

		const clamped = await request(`/api/schedules/${scheduleId}`, {
			method: "PATCH",
			body: { model: { provider: PLAIN, modelId: MODEL_ID } },
		});
		expect(clamped.status).toBe(200);
		expect(((await clamped.json()) as { schedule: { model: { thinkingLevel: string } } }).schedule.model).toEqual({
			provider: PLAIN,
			modelId: MODEL_ID,
			thinkingLevel: "off",
		});

		const back = await request(`/api/schedules/${scheduleId}`, {
			method: "PATCH",
			body: { model: { provider: THINK, modelId: MODEL_ID } },
		});
		expect(back.status).toBe(200);
		expect(((await back.json()) as { schedule: { model: { thinkingLevel: string } } }).schedule.model).toEqual({
			provider: THINK,
			modelId: MODEL_ID,
			thinkingLevel: "off",
		});

		const badPatch = await request(`/api/schedules/${scheduleId}`, {
			method: "PATCH",
			body: { model: { provider: PLAIN, modelId: MODEL_ID, thinkingLevel: "xhigh" } },
		});
		expect(badPatch.status).toBe(400);
	});
});

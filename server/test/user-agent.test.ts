import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelConfig, saveModelProvider } from "../src/agent/models.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { USER_AGENT, withUserAgent } from "../src/util/user-agent.ts";
import { CRH_VERSION } from "../src/version.ts";
import { openTestDb } from "./helpers/db.ts";

/** A Chat Completions endpoint that records each request's headers and answers "ok". */
function startStub(): Promise<{ server: Server; url: string; seen: IncomingHttpHeaders[] }> {
	const seen: IncomingHttpHeaders[] = [];
	const server = createServer((req, res) => {
		seen.push(req.headers);
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) =>
				res.write(
					`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices, ...extra })}\n\n`,
				);
			chunk([{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }]);
			chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
			chunk([], { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			res.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ server, url: `http://127.0.0.1:${port}/v1`, seen });
		});
	});
}

describe("withUserAgent", () => {
	const recorder = () => {
		const calls: Headers[] = [];
		const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			calls.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
			return new Response("ok");
		}) as typeof fetch;
		return { calls, fetchFn };
	};

	it("adds crhs's User-Agent where a request sets none, and keeps one it sets", async () => {
		expect(USER_AGENT).toBe(`ClusterRightHand/${CRH_VERSION} (crhs)`);
		const { calls, fetchFn } = recorder();
		const wrapped = withUserAgent(fetchFn);
		await wrapped("http://example.test/a", { headers: { accept: "text/plain" } });
		await wrapped("http://example.test/b", { headers: { "User-Agent": "configured/1" } });
		await wrapped(new Request("http://example.test/c", { headers: { "x-kept": "1" } }));
		expect(calls[0]?.get("user-agent")).toBe(USER_AGENT);
		expect(calls[0]?.get("accept")).toBe("text/plain");
		expect(calls[1]?.get("user-agent")).toBe("configured/1");
		expect(calls[2]?.get("user-agent")).toBe(USER_AGENT);
		expect(calls[2]?.get("x-kept")).toBe("1");
	});
});

describe("model requests", () => {
	let db: Db;
	let models: ModelConfig;
	let stub: Awaited<ReturnType<typeof startStub>>;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		const masterKey = MasterKey.generate();
		models = new ModelConfig(db, masterKey);
		stub = await startStub();
		await saveModelProvider(db, masterKey, {
			kind: "custom",
			providerId: "plain",
			name: "plain",
			baseUrl: stub.url,
			apiKey: "sk-stub",
			models: [{ id: "m-1", api: "openai-completions", contextWindow: 4096, maxTokens: 512, input: ["text"] }],
		});
		await saveModelProvider(db, masterKey, {
			kind: "custom",
			providerId: "custom-ua",
			name: "custom-ua",
			baseUrl: stub.url,
			apiKey: "sk-stub",
			headers: { "User-Agent": "gateway-client/2" },
			models: [{ id: "m-1", api: "openai-completions", contextWindow: 4096, maxTokens: 512, input: ["text"] }],
		});
		await models.reload();
	});

	afterAll(async () => {
		await new Promise((resolve) => stub.server.close(resolve));
		await db.destroy();
	});

	const ask = async (provider: string) => {
		const model = models.getModel(provider, "m-1");
		if (!model) throw new Error(`no model ${provider}/m-1`);
		const message = await models.completeSimple(model, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});
		expect(message.stopReason).toBe("stop");
		return stub.seen.at(-1);
	};

	it("carry crhs's User-Agent instead of the SDK's", async () => {
		expect((await ask("plain"))?.["user-agent"]).toBe(USER_AGENT);
	});

	it("keep a User-Agent the provider's headers configure", async () => {
		expect((await ask("custom-ua"))?.["user-agent"]).toBe("gateway-client/2");
	});
});

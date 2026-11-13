import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Api, type AssistantMessage, isRetryableAssistantError, type Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { meteredModels } from "../src/agent/metering.ts";
import { ModelConfig, saveModelProvider } from "../src/agent/models.ts";
import { MasterKey } from "../src/keys/master-key.ts";
import type { Db } from "../src/storage/db.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const KEY = "sk-network-test";

let db: Db;
let masterKey: MasterKey;
let models: ModelConfig;
let counter = 0;

beforeAll(async () => {
	db = await openTestDb("sqlite");
	masterKey = MasterKey.generate();
	models = new ModelConfig(db, masterKey);
	await models.reload();
});

afterAll(async () => {
	await db.destroy();
});

/** The metered registry a Harness gets; the network wrapper is installed here. */
const metered = () =>
	models.metered(
		async () => {},
		() => undefined,
	);

const ask = (model: Model<Api>, signal?: AbortSignal) =>
	metered().completeSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		signal ? { signal } : {},
	);

/** Stores a custom provider at `baseUrl` and returns its `m-1` model from the reloaded registry. */
async function configure(baseUrl: string): Promise<Model<Api>> {
	const providerId = `p-${++counter}`;
	await saveModelProvider(db, masterKey, {
		kind: "custom",
		providerId,
		name: providerId,
		baseUrl,
		apiKey: KEY,
		models: [{ id: "m-1", api: "openai-completions", contextWindow: 4096, maxTokens: 512, input: ["text"] }],
	});
	await models.reload();
	const model = models.getModel(providerId, "m-1");
	if (!model) throw new Error("the configured model must be in the registry");
	return model;
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}/v1`);
		});
	});
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A port no listener owns: the retired server was closed after binding one. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** One valid Chat Completions delta, enough for the SDK to enter its streaming parse loop. */
function chunk(delta: Record<string, unknown>): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "m-1",
		choices: [{ index: 0, delta, finish_reason: null }],
	})}\n\n`;
}

describe("provider network errors", () => {
	it("names the host, the read phase and the cause when the upstream drops mid-stream, and stays retryable", async () => {
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
				res.write(chunk({ role: "assistant", content: "ok" }));
				setTimeout(() => res.socket?.destroy(), 20);
			});
		});
		try {
			const model = await configure(await listen(server));
			const message = await ask(model);
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("Network error from crhs to 127.0.0.1");
			expect(message.errorMessage).toContain("while reading the streamed response");
			expect(message.errorMessage).toContain("terminated");
			expect(message.errorMessage).toContain("SocketError: other side closed");
			expect(isRetryableAssistantError(message)).toBe(true);
		} finally {
			await close(server);
		}
	});

	it("names the host, the connect phase and the cause when the connection is refused", async () => {
		const port = await closedPort();
		const model = await configure(`http://127.0.0.1:${port}/v1`);
		const message = await ask(model);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Network error from crhs to 127.0.0.1");
		expect(message.errorMessage).toContain("while connecting");
		expect(message.errorMessage).toContain("fetch failed");
		expect(message.errorMessage).toContain("ECONNREFUSED");
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	it("passes a user's abort through as an abort, not as a network error", async () => {
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
				res.write(chunk({ role: "assistant", content: "ok" }));
				// Keep the stream open until the request signal aborts it.
			});
		});
		try {
			const model = await configure(await listen(server));
			const controller = new AbortController();
			const pending = ask(model, controller.signal);
			setTimeout(() => controller.abort(), 100);
			const message = await pending;
			expect(message.stopReason).toBe("aborted");
			expect(message.errorMessage).not.toContain("Network error from crhs");
		} finally {
			await close(server);
		}
	});

	it("injects no fetch for an API whose adapter rejects one", async () => {
		let received: { fetch?: typeof fetch } | undefined;
		const fake = {
			completeSimple: async (_model: Model<Api>, _context: unknown, options?: { fetch?: typeof fetch }) => {
				received = options;
				return { role: "assistant", content: [], stopReason: "stop", timestamp: 0 } as unknown as AssistantMessage;
			},
		} as unknown as Models;
		const proxy = meteredModels(
			fake,
			async () => {},
			() => undefined,
		);
		await proxy.completeSimple(
			{ api: "google-generative-ai" } as Model<Api>,
			{ messages: [] },
			{ fetch: globalThis.fetch },
		);
		expect(received).toEqual({ fetch: globalThis.fetch });
	});
});

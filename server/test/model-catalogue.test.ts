import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CATALOGUE_REFRESH_MS,
	type CatalogueEntry,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	fillCatalogueModel,
	ModelCatalogue,
	parseModelsDevCatalogue,
} from "../src/agent/model-catalogue.ts";

/** A small models.dev-shaped catalogue: one provider, one model with everything the fill reads. */
const CATALOGUE = {
	gateway: {
		id: "gateway",
		name: "Gateway",
		api: "https://llm.example/v1",
		models: {
			"catalogue-a": {
				id: "catalogue-a",
				name: "Catalogue A",
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 128_000, output: 16_384 },
			},
		},
	},
};

function response(body: unknown, status = 200): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fake = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return handler(url, init);
	});
	return { fetch: fake as unknown as typeof fetch, calls };
}

function entry(overrides: Partial<CatalogueEntry> & { id: string }): CatalogueEntry {
	return {
		provider: "gateway",
		providerName: "Gateway",
		name: overrides.id,
		apiUrl: "https://llm.example/v1",
		contextWindow: 100_000,
		maxTokens: 10_000,
		image: true,
		reasoning: true,
		efforts: [],
		...overrides,
	};
}

describe("model catalogue refresh", () => {
	let dir: string;
	let now: number;
	const clock = () => now;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "crhs-catalogue-"));
		now = Date.UTC(2026, 0, 1);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(dir, { recursive: true, force: true });
	});

	const storedPath = () => join(dir, "models-dev", "api.json");
	const writeStored = async (body: unknown, at = now) => {
		const path = storedPath();
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(body));
		const stamp = new Date(at);
		await utimes(path, stamp, stamp);
	};

	it("downloads models.dev at most once per 24 h and stores the file under models-dev/", async () => {
		const { fetch, calls } = stubFetch(async () => response(CATALOGUE));
		const catalogue = new ModelCatalogue({ stateDir: dir, now: clock, fetch, log: () => {} });
		expect((await catalogue.load()).some((model) => model.id === "catalogue-a")).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://models.dev/api.json");
		expect(JSON.parse(await readFile(storedPath(), "utf8"))).toEqual(CATALOGUE);

		await catalogue.load();
		expect(calls).toHaveLength(1);
		now += CATALOGUE_REFRESH_MS - 1_000;
		await catalogue.load();
		expect(calls).toHaveLength(1);
		now += 2_000;
		await catalogue.load();
		expect(calls).toHaveLength(2);
	});

	it("refreshes the catalogue on a list request, before the provider's /models call", async () => {
		const { fetch, calls } = stubFetch(async (url) =>
			url === "https://models.dev/api.json" ? response(CATALOGUE) : response({ data: [{ id: "listed" }] }),
		);
		const catalogue = new ModelCatalogue({ stateDir: dir, now: clock, fetch, log: () => {} });
		expect(await catalogue.discover("https://llm.example/v1", "secret", undefined)).toEqual(["listed"]);
		expect(calls.map((call) => call.url)).toEqual(["https://models.dev/api.json", "https://llm.example/v1/models"]);
	});

	it("shares one download between concurrent list requests", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const { fetch, calls } = stubFetch(async () => {
			markStarted();
			await gate;
			return response(CATALOGUE);
		});
		const catalogue = new ModelCatalogue({ stateDir: dir, now: clock, fetch, log: () => {} });
		const first = catalogue.load();
		const second = catalogue.load();
		await started;
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(calls).toHaveLength(1);
		expect(a).toEqual(b);
		expect(a.some((model) => model.id === "catalogue-a")).toBe(true);
	});

	it("keeps the last good file when a download fails and logs the attempt once", async () => {
		let fail = false;
		const logs: string[] = [];
		const { fetch, calls } = stubFetch(async () => {
			if (fail) throw new Error("network down");
			return response(CATALOGUE);
		});
		const catalogue = new ModelCatalogue({ stateDir: dir, now: clock, fetch, log: (m) => logs.push(m) });
		expect((await catalogue.load()).some((model) => model.id === "catalogue-a")).toBe(true);
		now += CATALOGUE_REFRESH_MS + 1;
		fail = true;
		const entries = await catalogue.load();
		expect(entries.some((model) => model.id === "catalogue-a")).toBe(true);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("network down");
		expect(JSON.parse(await readFile(storedPath(), "utf8"))).toEqual(CATALOGUE);
		// The failed attempt counts as the day's refresh; no new attempt on the next list request.
		await catalogue.load();
		expect(calls).toHaveLength(2);
		expect(logs).toHaveLength(1);
	});

	it("does not install a body that is not a usable catalogue", async () => {
		const logs: string[] = [];
		let body = "not json";
		const { fetch } = stubFetch(async () => response(body));
		const catalogue = new ModelCatalogue({ stateDir: dir, now: clock, fetch, log: (m) => logs.push(m) });
		const offline = await catalogue.load();
		expect(offline.some((model) => model.id === "catalogue-a")).toBe(false);
		await expect(stat(storedPath())).rejects.toThrow();
		// A day later, an object that has no usable models is rejected too.
		now += CATALOGUE_REFRESH_MS + 1;
		body = JSON.stringify({ provider: { models: {} } });
		await catalogue.load();
		await expect(stat(storedPath())).rejects.toThrow();
		expect(logs).toHaveLength(2);

		// A good file is not replaced by an invalid body.
		await writeStored(CATALOGUE);
		now += CATALOGUE_REFRESH_MS + 1;
		body = "still not json";
		const kept = await catalogue.load();
		expect(kept.some((model) => model.id === "catalogue-a")).toBe(true);
		expect(JSON.parse(await readFile(storedPath(), "utf8"))).toEqual(CATALOGUE);
	});

	it("uses the pi-ai offline catalogue when no models.dev file has ever been stored", async () => {
		const { fetch, calls } = stubFetch(async () => {
			throw new Error("offline");
		});
		const catalogue = new ModelCatalogue({ stateDir: dir, now: clock, fetch, log: () => {} });
		const entries = await catalogue.load();
		expect(entries.length).toBeGreaterThan(100);
		expect(entries.some((model) => model.id === "catalogue-a")).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it("never downloads when the crhs.toml switch is off but still uses a stored file", async () => {
		await writeStored(CATALOGUE, now - 30 * 24 * 60 * 60 * 1000);
		const { fetch, calls } = stubFetch(async () => response(CATALOGUE));
		const withFile = new ModelCatalogue({ stateDir: dir, download: false, now: clock, fetch, log: () => {} });
		expect((await withFile.load()).some((model) => model.id === "catalogue-a")).toBe(true);
		expect(calls).toHaveLength(0);

		await rm(join(dir, "models-dev"), { recursive: true, force: true });
		const offline = new ModelCatalogue({
			stateDir: dir,
			download: false,
			now: clock,
			fetch,
			log: () => {},
		});
		const entries = await offline.load();
		expect(entries.length).toBeGreaterThan(100);
		expect(calls).toHaveLength(0);
	});
});

describe("catalogue filling", () => {
	const BASE = "https://llm.example/v1";

	it("prefers a provider whose api host matches the base URL", () => {
		const entries = [
			entry({ id: "shared", provider: "on-host", apiUrl: "https://llm.example/other/v1", contextWindow: 64_000 }),
			entry({ id: "shared", provider: "elsewhere", apiUrl: "https://other.example/v1", contextWindow: 400_000 }),
		];
		const model = fillCatalogueModel(entries, BASE, "shared");
		expect(model.contextWindow).toBe(64_000);
	});

	it("takes the minimum context and output of several matches, and image/reasoning only when all agree", () => {
		const entries = [
			entry({ id: "shared", provider: "b", contextWindow: 100_000, maxTokens: 10_000, image: true, reasoning: true }),
			entry({
				id: "shared",
				provider: "a",
				contextWindow: 50_000,
				maxTokens: 20_000,
				image: true,
				reasoning: true,
				name: "Shared Model",
			}),
			entry({ id: "shared", provider: "c", contextWindow: 200_000, maxTokens: 5_000, image: false, reasoning: false }),
		];
		const model = fillCatalogueModel(entries, "https://unrelated.example/v1", "shared");
		expect(model).toMatchObject({
			id: "shared",
			api: "openai-completions",
			contextWindow: 50_000,
			maxTokens: 5_000,
			input: ["text"],
			name: "Shared Model",
		});
		expect(model.thinking).toBeUndefined();
	});

	it("agrees on image and reasoning only when every match offers them", () => {
		const entries = [
			entry({ id: "shared", provider: "a", image: true, reasoning: true }),
			entry({ id: "shared", provider: "b", image: true, reasoning: true }),
		];
		const model = fillCatalogueModel(entries, "https://unrelated.example/v1", "shared");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.thinking).toEqual({ mode: "standard", levels: {} });
	});

	it("retries the lookup with the id after the last slash", () => {
		const entries = [
			entry({ id: "deepseek-v4-flash", provider: "somewhere", apiUrl: "https://other.example/v1", name: "Flash" }),
		];
		const model = fillCatalogueModel(entries, BASE, "deepseek/deepseek-v4-flash");
		expect(model).toMatchObject({ id: "deepseek/deepseek-v4-flash", name: "Flash", contextWindow: 100_000 });
	});

	it("falls back to conservative defaults when nothing matches", () => {
		const model = fillCatalogueModel([], BASE, "unknown/model");
		expect(model).toEqual({
			id: "unknown/model",
			api: "openai-completions",
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
			input: ["text"],
		});
	});

	it("fills the max output fallback and caps an output larger than the context", () => {
		const zero = fillCatalogueModel(
			[entry({ id: "zero", contextWindow: 100_000, maxTokens: undefined })],
			BASE,
			"zero",
		);
		expect(zero.maxTokens).toBe(DEFAULT_MAX_TOKENS);
		const small = fillCatalogueModel(
			[entry({ id: "small", contextWindow: 2_048, maxTokens: undefined })],
			BASE,
			"small",
		);
		expect(small.maxTokens).toBe(2_048);
		const huge = fillCatalogueModel([entry({ id: "huge", contextWindow: 8_000, maxTokens: 100_000 })], BASE, "huge");
		expect(huge.maxTokens).toBe(8_000);
	});

	it("maps models.dev effort options onto pi-ai levels and ignores non-efforts", () => {
		const entries = parseModelsDevCatalogue({
			gateway: {
				name: "Gateway",
				api: BASE,
				models: {
					efforts: {
						id: "efforts",
						name: "Efforts",
						reasoning: true,
						reasoning_options: [
							{ type: "toggle" },
							{ type: "effort", values: ["low", "none", "high", "max", "xhigh"] },
							{ type: "budget_tokens", min: 1024 },
						],
						modalities: { input: ["text"] },
						limit: { context: 64_000, output: 8_000 },
					},
					toggle: {
						id: "toggle",
						name: "Toggle",
						reasoning: true,
						reasoning_options: [{ type: "toggle" }],
						limit: { context: 32_768, output: 4_096 },
					},
				},
			},
		});
		if (entries === null) throw new Error("fixture did not parse");
		const efforts = fillCatalogueModel(entries, BASE, "efforts");
		expect(efforts.thinking).toEqual({
			mode: "standard",
			levels: { low: "low", high: "high", xhigh: "xhigh", max: "max" },
		});
		// A toggle alone means the manual dialog's default (empty) level map.
		expect(fillCatalogueModel(entries, BASE, "toggle").thinking).toEqual({ mode: "standard", levels: {} });
	});

	it("maps only the efforts every match offers", () => {
		const entries = [
			entry({ id: "shared", provider: "a", efforts: ["low", "high"] }),
			entry({ id: "shared", provider: "b", efforts: ["high", "max"] }),
		];
		const model = fillCatalogueModel(entries, "https://unrelated.example/v1", "shared");
		expect(model.thinking).toEqual({ mode: "standard", levels: { high: "high" } });
	});
});

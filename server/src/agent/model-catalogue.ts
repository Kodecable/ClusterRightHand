// The models.dev model catalogue cache and the upstream model listing behind the custom-provider
// "List provider models" dialog (doc/design/agent-runtime.md "Custom providers").

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CustomModel, ThinkingLevel } from "@crh/api";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { BadGatewayError, errorText, UserError } from "../util/errors.ts";
import { THINKING_LEVELS } from "./model-types.ts";
import { isPlainObject } from "./model-validate.ts";

/** Where models.dev publishes its catalogue. */
export const MODELS_DEV_URL = "https://models.dev/api.json";
/** The fresh-life of the stored catalogue: at most one download a day. */
export const CATALOGUE_REFRESH_MS = 24 * 60 * 60 * 1000;
/** The download of the catalogue gives up after this long. */
export const CATALOGUE_TIMEOUT_MS = 10_000;
/** Listing a provider's models gives up after this long. */
export const DISCOVERY_TIMEOUT_MS = 15_000;
/** Conservative values for a model the catalogue does not know (doc/design/agent-runtime.md "Custom providers"). */
export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_TOKENS = 4_096;

/** One model of a catalogue, either models.dev or pi-ai's bundled copy of it. */
export interface CatalogueEntry {
	/** The catalogue provider id (models.dev, or the pi-ai provider id offline). */
	provider: string;
	providerName: string;
	id: string;
	name: string | undefined;
	/** The provider's API URL (models.dev `api`, or a model's `provider.api` override). */
	apiUrl: string | undefined;
	contextWindow: number | undefined;
	maxTokens: number | undefined;
	image: boolean;
	reasoning: boolean;
	/** The pi-ai thinking levels the reasoning options list as efforts, in `THINKING_LEVELS` order. */
	efforts: readonly ThinkingLevel[];
}

export interface ModelCatalogueOptions {
	/**
	 * crhs's data directory: the catalogue is cached in `<stateDir>/models-dev/api.json`. Omitted for an
	 * offline-only catalogue (tests and callers without a data directory): nothing is read or written.
	 */
	stateDir?: string | undefined;
	/** Whether models.dev may be downloaded (`crhs.toml` `[models] catalog_download`, default true). */
	download?: boolean;
	/** Tests: the fetch used for both models.dev and a provider's `/models`. */
	fetch?: typeof fetch;
	/** Tests: the current time in milliseconds. */
	now?: () => number;
	/** Where a failed catalogue download is logged, once per attempt. */
	log?: (message: string) => void;
	catalogueUrl?: string;
	refreshMs?: number;
	catalogueTimeoutMs?: number;
	discoveryTimeoutMs?: number;
}

/** The prompt-completion protocol every discovered model uses. */
const CUSTOM_API = "openai-completions";

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The host of an API URL, as compared between a provider's base URL and a catalogue entry. */
function hostOf(url: string | undefined): string | undefined {
	if (url === undefined) return undefined;
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return undefined;
	}
}

/** pi-ai levels that an effort option may name; `off` is the absence of thinking, not an effort. */
function piLevel(value: string): ThinkingLevel | undefined {
	return value === "off" ? undefined : THINKING_LEVELS.find((level) => level === value);
}

/**
 * Normalizes models.dev's `api.json`: providers keyed by id, each with `models` keyed by model id. Only the
 * fields the model dialog fills are read. Returns null when nothing usable is present, which keeps a broken
 * download or file from replacing a good one.
 */
export function parseModelsDevCatalogue(raw: unknown): CatalogueEntry[] | null {
	if (!isPlainObject(raw)) return null;
	const entries: CatalogueEntry[] = [];
	for (const [providerId, providerRaw] of Object.entries(raw)) {
		if (!isPlainObject(providerRaw)) continue;
		const providerName = text(providerRaw.name) ?? providerId;
		const providerApi = text(providerRaw.api);
		const models = isPlainObject(providerRaw.models) ? providerRaw.models : undefined;
		if (models === undefined) continue;
		for (const [key, modelRaw] of Object.entries(models)) {
			if (!isPlainObject(modelRaw)) continue;
			const id = text(modelRaw.id) ?? key;
			if (id === "") continue;
			const limit = isPlainObject(modelRaw.limit) ? modelRaw.limit : {};
			const modalities = isPlainObject(modelRaw.modalities) ? modelRaw.modalities : {};
			const inputs = Array.isArray(modalities.input) ? modalities.input : [];
			const efforts = new Set<ThinkingLevel>();
			if (Array.isArray(modelRaw.reasoning_options)) {
				for (const option of modelRaw.reasoning_options) {
					if (!isPlainObject(option) || option.type !== "effort" || !Array.isArray(option.values)) continue;
					for (const value of option.values) {
						const level = typeof value === "string" ? piLevel(value) : undefined;
						if (level !== undefined) efforts.add(level);
					}
				}
			}
			const override = isPlainObject(modelRaw.provider) ? text(modelRaw.provider.api) : undefined;
			entries.push({
				provider: providerId,
				providerName,
				id,
				name: text(modelRaw.name),
				apiUrl: override ?? providerApi,
				contextWindow: positiveInteger(limit.context),
				maxTokens: positiveInteger(limit.output),
				image: inputs.includes("image"),
				reasoning: modelRaw.reasoning === true,
				efforts: THINKING_LEVELS.filter((level) => efforts.has(level)),
			});
		}
	}
	return entries.length > 0 ? entries : null;
}

/** The minimum of the defined values, or undefined when none is known. */
function minimum(values: readonly (number | undefined)[]): number | undefined {
	const defined = values.filter((value): value is number => value !== undefined);
	return defined.length === 0 ? undefined : Math.min(...defined);
}

/** The levels every match offers, in pi-ai order. */
function sharedEfforts(matches: readonly CatalogueEntry[]): ThinkingLevel[] {
	const [first, ...rest] = matches;
	if (first === undefined) return [];
	return first.efforts.filter((level) => rest.every((match) => match.efforts.includes(level)));
}

/** The catalogue entries for a model id, applying the lookup order of doc/design/agent-runtime.md "Custom providers". */
function findMatches(entries: readonly CatalogueEntry[], baseUrl: string, id: string): CatalogueEntry[] {
	const host = hostOf(baseUrl);
	const onHost = (modelId: string): CatalogueEntry[] =>
		host === undefined ? [] : entries.filter((entry) => entry.id === modelId && hostOf(entry.apiUrl) === host);
	const exact = onHost(id);
	if (exact.length > 0) return exact.sort(byName);
	const anywhere = entries.filter((entry) => entry.id === id);
	if (anywhere.length > 0) return anywhere.sort(byName);
	// A gateway may spell an upstream id with a provider prefix (`deepseek/deepseek-v4-flash`).
	const slash = id.lastIndexOf("/");
	if (slash === -1 || slash === id.length - 1) return [];
	const shortId = id.slice(slash + 1);
	const shortOnHost = onHost(shortId);
	if (shortOnHost.length > 0) return shortOnHost.sort(byName);
	return entries.filter((entry) => entry.id === shortId).sort(byName);
}

function byName(left: CatalogueEntry, right: CatalogueEntry): number {
	return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
}

/**
 * Fills one model from the catalogue (doc/design/agent-runtime.md "Custom providers"): the minimum context and
 * output of every match, image input and reasoning only when every match agrees, and the efforts every match
 * maps. Unknown models get the conservative defaults.
 */
export function fillCatalogueModel(entries: readonly CatalogueEntry[], baseUrl: string, id: string): CustomModel {
	const matches = findMatches(entries, baseUrl, id);
	if (matches.length === 0) {
		return {
			id,
			api: CUSTOM_API,
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			maxTokens: DEFAULT_MAX_TOKENS,
			input: ["text"],
		};
	}
	const contextWindow = minimum(matches.map((match) => match.contextWindow)) ?? DEFAULT_CONTEXT_WINDOW;
	// A missing or zero output falls back to min(context, 4096); an output larger than the context is capped.
	const output = minimum(matches.map((match) => match.maxTokens));
	const maxTokens = Math.min(output ?? Math.min(contextWindow, DEFAULT_MAX_TOKENS), contextWindow);
	const reasoning = matches.every((match) => match.reasoning);
	const efforts = sharedEfforts(matches);
	const name = matches[0]?.name;
	return {
		id,
		...(name !== undefined ? { name } : {}),
		api: CUSTOM_API,
		contextWindow,
		maxTokens,
		input: matches.every((match) => match.image) ? ["text", "image"] : ["text"],
		...(reasoning
			? {
					thinking: {
						mode: "standard" as const,
						// No format: pi-ai detects it from the base URL. The manual model dialog's default map.
						levels: Object.fromEntries(efforts.map((level) => [level, level])),
					},
				}
			: {}),
	};
}

/** The pi-ai built-in catalogue, used when no models.dev file is available. */
function offlineEntries(): CatalogueEntry[] {
	const entries: CatalogueEntry[] = [];
	for (const provider of builtinProviders()) {
		for (const model of provider.getModels()) {
			entries.push({
				provider: provider.id,
				providerName: provider.name,
				id: model.id,
				name: model.name,
				apiUrl: model.baseUrl,
				contextWindow: positiveInteger(model.contextWindow),
				maxTokens: positiveInteger(model.maxTokens),
				image: model.input.includes("image"),
				reasoning: model.reasoning === true,
				// The bundled catalogue has no models.dev reasoning options; the default level map is used.
				efforts: [],
			});
		}
	}
	return entries;
}

/**
 * The models.dev catalogue cache and the provider `/models` listing (doc/design/agent-runtime.md "Custom
 * providers"). The download is throttled to once a day, single-flight, and only replaces the stored file after
 * it parses and has a usable shape; a failed download keeps the last good file, and with no file at all the
 * pi-ai bundled catalogue is used.
 */
export class ModelCatalogue {
	readonly #stateDir: string | undefined;
	readonly #download: boolean;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	readonly #url: string;
	readonly #refreshMs: number;
	readonly #catalogueTimeoutMs: number;
	readonly #discoveryTimeoutMs: number;
	#cached: { mtimeMs: number; entries: CatalogueEntry[] } | undefined;
	#badFileMtimeMs: number | undefined;
	#offline: CatalogueEntry[] | undefined;
	#refreshing: Promise<void> | undefined;
	#lastAttemptAt: number | undefined;

	constructor(options: ModelCatalogueOptions = {}) {
		this.#stateDir = options.stateDir;
		this.#download = options.download ?? true;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? ((message) => console.warn(`crhs: ${message}`));
		this.#url = options.catalogueUrl ?? MODELS_DEV_URL;
		this.#refreshMs = options.refreshMs ?? CATALOGUE_REFRESH_MS;
		this.#catalogueTimeoutMs = options.catalogueTimeoutMs ?? CATALOGUE_TIMEOUT_MS;
		this.#discoveryTimeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
	}

	#path(): string | undefined {
		return this.#stateDir === undefined ? undefined : join(this.#stateDir, "models-dev", "api.json");
	}

	async #mtime(path: string): Promise<number | undefined> {
		try {
			return (await stat(path)).mtimeMs;
		} catch {
			return undefined;
		}
	}

	/**
	 * The current catalogue. Refreshes models.dev first when it may and the stored file is a day old; then uses
	 * the stored file when it is usable, and pi-ai's bundled catalogue otherwise.
	 */
	async load(): Promise<CatalogueEntry[]> {
		await this.#refreshIfDue();
		const path = this.#path();
		if (path !== undefined) {
			const mtime = await this.#mtime(path);
			if (mtime !== undefined) {
				if (this.#cached?.mtimeMs !== mtime) await this.#readFile(path, mtime);
				if (this.#cached !== undefined) return this.#cached.entries;
			} else {
				this.#cached = undefined;
			}
		}
		this.#offline ??= offlineEntries();
		return this.#offline;
	}

	/** The model ids a provider lists on `GET {baseUrl}/models`, without duplicates (doc/design/agent-runtime.md "Custom providers"). */
	async discover(
		baseUrl: string,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
	): Promise<string[]> {
		// Every list request is a chance to refresh models.dev, which the save then uses to fill its models.
		await this.load();
		const endpoint = `${baseUrl.replace(/\/+$/, "")}/models`;
		let url: URL;
		try {
			url = new URL(endpoint);
		} catch {
			throw new UserError("the provider's base URL is not an absolute URL");
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new UserError("the provider's base URL must be http(s)");
		}
		const requestHeaders = new Headers();
		requestHeaders.set("accept", "application/json");
		for (const [name, value] of Object.entries(headers ?? {})) requestHeaders.set(name, value);
		// The stored key is authoritative: a header from the configuration must not shadow it.
		if (apiKey !== undefined) requestHeaders.set("authorization", `Bearer ${apiKey}`);
		let response: Response;
		try {
			response = await this.#fetch(url.toString(), {
				headers: requestHeaders,
				signal: AbortSignal.timeout(this.#discoveryTimeoutMs),
			});
		} catch (err) {
			if (isTimeout(err)) {
				throw new BadGatewayError(
					`listing models failed: the provider did not answer within ${this.#discoveryTimeoutMs / 1000} s`,
				);
			}
			throw new BadGatewayError(`listing models failed: could not reach the provider (${errorText(err)})`);
		}
		if (!response.ok) {
			const status = response.statusText === "" ? `${response.status}` : `${response.status} ${response.statusText}`;
			throw new BadGatewayError(`listing models failed: the provider answered ${status}`);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new BadGatewayError("listing models failed: the provider did not return JSON");
		}
		if (!isPlainObject(body) || !Array.isArray(body.data)) {
			throw new BadGatewayError('listing models failed: the provider did not return a "data" list of models');
		}
		const models: string[] = [];
		const seen = new Set<string>();
		for (const entry of body.data) {
			if (!isPlainObject(entry)) continue;
			const id = text(entry.id);
			if (id === undefined || seen.has(id)) continue;
			seen.add(id);
			models.push(id);
		}
		if (models.length === 0 && body.data.length > 0) {
			throw new BadGatewayError('listing models failed: the "data" list has no model ids');
		}
		return models;
	}

	/** Fills the given ids from the current catalogue (doc/design/agent-runtime.md "Custom providers"). */
	async fill(ids: readonly string[], baseUrl: string): Promise<CustomModel[]> {
		const entries = await this.load();
		return ids.map((id) => fillCatalogueModel(entries, baseUrl, id));
	}

	async #readFile(path: string, mtime: number): Promise<void> {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(path, "utf8"));
		} catch (err) {
			if (this.#badFileMtimeMs !== mtime) {
				this.#log(`ignoring an unusable models.dev catalogue file: ${errorText(err)}`);
				this.#badFileMtimeMs = mtime;
			}
			this.#cached = undefined;
			return;
		}
		const entries = parseModelsDevCatalogue(raw);
		if (entries === null) {
			if (this.#badFileMtimeMs !== mtime) {
				this.#log("ignoring a models.dev catalogue file with no models");
				this.#badFileMtimeMs = mtime;
			}
			this.#cached = undefined;
			return;
		}
		this.#badFileMtimeMs = undefined;
		this.#cached = { mtimeMs: mtime, entries };
	}

	async #refreshIfDue(): Promise<void> {
		const path = this.#path();
		if (path === undefined || !this.#download) return;
		const now = this.#now();
		const mtime = await this.#mtime(path);
		if (mtime !== undefined && now - mtime < this.#refreshMs) return;
		// Single flight: a concurrent list request waits for the download already running instead of
		// starting one, or returning before it can use the file it writes.
		if (this.#refreshing !== undefined) {
			await this.#refreshing;
			return;
		}
		if (this.#lastAttemptAt !== undefined && now - this.#lastAttemptAt < this.#refreshMs) return;
		const run = this.#downloadCatalogue(path, now);
		this.#refreshing = run;
		try {
			await run;
		} finally {
			if (this.#refreshing === run) this.#refreshing = undefined;
		}
	}

	async #downloadCatalogue(path: string, now: number): Promise<void> {
		this.#lastAttemptAt = now;
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			const response = await this.#fetch(this.#url, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(this.#catalogueTimeoutMs),
			});
			if (!response.ok) throw new Error(`the server answered ${response.status}`);
			const body = await response.text();
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				throw new Error("the body is not JSON");
			}
			const entries = parseModelsDevCatalogue(parsed);
			if (entries === null) throw new Error("the body has no usable models");
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(temporary, body, { mode: 0o600 });
			// The refresh age is measured against the catalogue's mtime, which follows the injected clock too.
			const stamp = new Date(now);
			await utimes(temporary, stamp, stamp);
			await rename(temporary, path);
			this.#cached = { mtimeMs: now, entries };
			this.#badFileMtimeMs = undefined;
		} catch (err) {
			if (isTimeout(err))
				this.#log(`models.dev catalogue refresh failed: no answer within ${this.#catalogueTimeoutMs / 1000} s`);
			else this.#log(`models.dev catalogue refresh failed: ${errorText(err)}`);
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
	}
}

function isTimeout(err: unknown): boolean {
	return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

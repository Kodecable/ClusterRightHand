import type { ExtensionConfigField } from "@crh/api";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { UserError } from "../util/errors.ts";
import type { BuiltinExtensionProvider } from "./builtin.ts";
import { DOC_PAGE_LINES, pageLines } from "./docs.ts";
import {
	type ExtensionCallContext,
	type ExtensionTool,
	ExtensionToolError,
	ExtensionUnavailableError,
} from "./model.ts";

/**
 * `crhs-ds-search`: web search and page fetch through DeepSeek's Search and Fetch APIs
 * (doc/design/extensions.md "Built-in extensions"; https://api-docs.deepseek.com/guides/search/). Both are
 * billed per successful request, so the extension ships disabled and needs an API key before it can be
 * enabled. Both are read-only on the web and are `ext.read`; like any tool that reaches the network, what
 * the model puts in a query or a URL leaves crhs (doc/design/extensions.md "Rules and approvals").
 */

const DEFAULT_BASE_URL = "https://api.deepseek.com";
/** One request may take this long; DeepSeek's own downstream timeout answers 504 before. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Retries of a 408, 429 or 5xx answer, the ones DeepSeek says to retry, with doubling waits from this base. */
const RETRIES = 2;
const RETRY_BASE_MS = 500;
/** The Search API's own limit; the tool output limit bounds what reaches the model. */
const MAX_COUNT = 50;
const DEFAULT_COUNT = 10;
const MAX_QUERY_CHARS = 128;
const MAX_URL_CHARS = 8192;

const CONFIG: readonly ExtensionConfigField[] = [
	{
		key: "apiKey",
		label: "API key",
		kind: "secret",
		required: true,
		description: "A DeepSeek API key; Search and Fetch are billed to its account per successful request.",
		default: null,
	},
	{
		key: "baseUrl",
		label: "Base URL",
		kind: "string",
		required: false,
		description: "The DeepSeek API base URL.",
		default: DEFAULT_BASE_URL,
	},
];

const TOOLS: readonly ExtensionTool[] = [
	{
		name: "search",
		title: "Web search",
		description:
			"Search the web and return ranked results with a title, URL, date and a summary written for a model. " +
			'The query supports site:, -site:, "exact phrase", -term, lang:zh,en, after:2025-01-01 and before:2026. ' +
			"Use fetch to read a result in full.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: `What to search for, at most ${MAX_QUERY_CHARS} characters` },
				count: {
					type: "integer",
					minimum: 1,
					maximum: MAX_COUNT,
					description: `How many results (default ${DEFAULT_COUNT}, at most ${MAX_COUNT})`,
				},
				need_content: {
					type: "boolean",
					description: "Also return each page's content; usually fetch the one page that matters instead",
				},
				ori_question: {
					type: "string",
					description: `The user's original question, at most ${MAX_QUERY_CHARS} characters; improves ranking`,
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "fetch",
		title: "Fetch a web page",
		description:
			"Fetch one web page and return its title and content as Markdown, as much as one tool result holds. A " +
			"longer page ends with the offset to continue at; continuing fetches the page again.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "An http(s) URL without a username or password" },
				offset: {
					type: "integer",
					minimum: 1,
					description: "Line to continue at when the page did not fit in one result (1-based; default 1)",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
];

interface SearchResult {
	title?: string;
	url?: string;
	summary?: string;
	content?: string;
	site_name?: string | null;
	date?: string | null;
	authority?: number;
}

function textResult(...parts: string[]): CallToolResult {
	return { content: parts.filter((part) => part !== "").map((text) => ({ type: "text" as const, text })) };
}

function text(value: unknown, what: string, max: number): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new UserError(`${what} is required`, "invalid_argument");
	}
	if ([...value].length > max) throw new UserError(`${what} is at most ${max} characters`, "invalid_argument");
	return value;
}

function integer(value: unknown, what: string, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new UserError(`${what} must be an integer from ${min} to ${max}`, "invalid_argument");
	}
	return value;
}

/** The URL the Fetch API accepts: http(s), with a host and no credentials. */
function pageUrl(value: unknown): string {
	const raw = text(value, "url", MAX_URL_CHARS);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UserError("url must be an absolute http(s) URL", "invalid_argument");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
		throw new UserError("url must be an http(s) URL with a host", "invalid_argument");
	}
	if (url.username !== "" || url.password !== "") {
		throw new UserError("url must not contain a username or password", "invalid_argument");
	}
	return raw;
}

function settings(context: ExtensionCallContext): { apiKey: string; baseUrl: string } {
	const apiKey = context.config?.apiKey;
	if (typeof apiKey !== "string" || apiKey === "") {
		throw new ExtensionUnavailableError(
			"crhs-ds-search has no API key; an administrator sets it on the Extensions page",
		);
	}
	const base = context.config?.baseUrl;
	return { apiKey, baseUrl: (typeof base === "string" && base !== "" ? base : DEFAULT_BASE_URL).replace(/\/+$/, "") };
}

/** Waits, unless the call is aborted first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** The message of DeepSeek's OpenAI-style error body, or the status alone. */
async function errorMessage(response: Response): Promise<string> {
	const body = await response.text().catch(() => "");
	try {
		const parsed = JSON.parse(body) as { error?: { message?: unknown } };
		if (typeof parsed.error?.message === "string") return parsed.error.message;
	} catch {
		// Not JSON: fall through to the status.
	}
	return body.trim().slice(0, 300) || `HTTP ${response.status}`;
}

/**
 * One POST to a tool endpoint. 408, 429 and 5xx are retried a few times, as DeepSeek advises; any other
 * failure is reported to the model as it is, and an unreachable API makes the extension unavailable.
 */
async function post(context: ExtensionCallContext, path: string, body: Record<string, unknown>): Promise<unknown> {
	const { apiKey, baseUrl } = settings(context);
	for (let attempt = 0; ; attempt += 1) {
		const signal = context.signal
			? AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
			: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetch(`${baseUrl}${path}`, {
				method: "POST",
				headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			if (context.signal?.aborted) throw new ExtensionToolError("the call was aborted");
			const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not be reached";
			throw new ExtensionUnavailableError(`the DeepSeek API ${reason}`);
		}
		if (response.ok) return response.json();
		const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
		if (retryable && attempt < RETRIES && !context.signal?.aborted) {
			await response.body?.cancel().catch(() => undefined);
			await sleep(RETRY_BASE_MS * 2 ** attempt, context.signal);
			continue;
		}
		const message = await errorMessage(response);
		switch (response.status) {
			case 401:
				throw new ExtensionUnavailableError(`DeepSeek refused the API key: ${message}`);
			case 402:
				throw new ExtensionUnavailableError(`the DeepSeek account has insufficient balance: ${message}`);
			case 403:
				throw new ExtensionToolError(`DeepSeek's security policy refused the page: ${message}`);
			case 404:
				throw new ExtensionToolError(`DeepSeek could not get usable content from the page: ${message}`);
			case 429:
				throw new ExtensionToolError(`DeepSeek's rate limit was reached: ${message}`);
			default:
				throw new ExtensionToolError(`DeepSeek answered ${response.status}: ${message}`);
		}
	}
}

/** One result as the model reads it: where it is from, then the summary written for a model. */
function formatResult(index: number, result: SearchResult, withContent: boolean): string {
	const source = [result.site_name, result.date?.slice(0, 10)].filter((part) => part).join(", ");
	const lines = [`[${index}] ${result.title || "(untitled)"}`, result.url ?? ""];
	if (source !== "") lines.push(source);
	if (result.summary) lines.push("", result.summary);
	if (withContent && result.content) lines.push("", result.content);
	return lines.join("\n");
}

async function searchCall(args: Record<string, unknown>, context: ExtensionCallContext): Promise<CallToolResult> {
	const query = text(args.query, "query", MAX_QUERY_CHARS);
	const count = integer(args.count, "count", DEFAULT_COUNT, 1, MAX_COUNT);
	const needContent = args.need_content === true;
	const question =
		args.ori_question === undefined ? undefined : text(args.ori_question, "ori_question", MAX_QUERY_CHARS);
	const body = (await post(context, "/v1/tools/search", {
		query,
		count,
		need_content: needContent,
		...(question === undefined ? {} : { ori_question: question }),
	})) as { results?: SearchResult[] };
	const results = Array.isArray(body.results) ? body.results : [];
	if (results.length === 0) return textResult(`[crhs-ds-search: no results for ${JSON.stringify(query)}]`);
	return textResult(
		results.map((result, index) => formatResult(index + 1, result, needContent)).join("\n\n"),
		`[crhs-ds-search: ${results.length} result${results.length === 1 ? "" : "s"} for ${JSON.stringify(query)}; read one with fetch]`,
	);
}

async function fetchCall(args: Record<string, unknown>, context: ExtensionCallContext): Promise<CallToolResult> {
	const url = pageUrl(args.url);
	const offset = integer(args.offset, "offset", 1, 1, Number.MAX_SAFE_INTEGER);
	const page = (await post(context, "/v1/tools/fetch", { url })) as { title?: string; content?: string };
	const lines = (page.content ?? "").split("\n");
	// No limit of its own: as much as one tool result holds, the same bound every tool output has.
	const paged = pageLines(lines, url, "page", offset, DOC_PAGE_LINES, "fetch");
	return textResult(offset === 1 && page.title ? `# ${page.title}` : "", paged.output, paged.note);
}

export const dsSearch: BuiltinExtensionProvider = {
	name: "crhs-ds-search",
	description: "Web search and page fetch through DeepSeek's Search and Fetch APIs",
	config: CONFIG,
	tools: () => TOOLS,
	async call(tool, args, context) {
		if (tool === "search") return searchCall(args, context);
		if (tool === "fetch") return fetchCall(args, context);
		throw new ExtensionToolError(`the crhs-ds-search extension has no tool named ${tool}`);
	},
	operation: (tool) => ({ method: "ext.read", target: `crhs-ds-search/${tool}` }),
};

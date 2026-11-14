import type { Operation } from "@crh/api";
import type { CallToolResult } from "@modelcontextprotocol/client";
import * as z from "zod/v4";
import type { InternalRequestIdentity } from "../api/context.ts";
import { UserError } from "../util/errors.ts";
import { type ApiRoute, matchApiRoute } from "./api-reference.ts";

/**
 * `api_request`, the `api` extension's tool (doc/design/extensions.md "API requests"). A request runs through
 * the app's own router instead of the network, as the session owner, so it passes the same route definition,
 * validation, access checks and audit as a WebUI request. The route's declared agent access is the first
 * gate: `deny`, an unknown route and a path outside `/api` are refused without rules; `allow` becomes an
 * `api.read` operation and `ask` an `api.write` one, which the ordinary external-call flow then judges.
 */

/** The largest request body the tool accepts, matching the API's ordinary JSON body limit. */
export const API_REQUEST_BODY_LIMIT = 1024 * 1024;
/** The output limits every tool uses. */
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

const queryValue = z.union([z.string(), z.number(), z.boolean()]);
const apiRequestInput = z.object({
	method: z.string().min(1),
	path: z.string().min(1),
	query: z.record(z.string(), queryValue).optional(),
	body: z.unknown().optional(),
});

/**
 * The body as JSON. Some models send the body as a string holding JSON although the schema asks for an
 * object; every API body is an object or a list, so such a string is read as the JSON it holds.
 */
function bodyValue(body: unknown): unknown {
	if (typeof body !== "string") return body;
	try {
		const value: unknown = JSON.parse(body);
		if (typeof value === "object" && value !== null) return value;
	} catch {
		// Not JSON: sent as the string it is, and the route's schema rejects it.
	}
	return body;
}

export interface NormalizedApiRequest {
	/** Upper-case HTTP method. */
	method: string;
	/** The path, starting with `/api/`. */
	path: string;
	/** Query parameters as URLSearchParams entries. */
	query: [string, string][];
	/** The compact JSON body, when one was given. */
	body: string | undefined;
}

function invalid(message: string): UserError {
	return new UserError(`api_request: ${message}`, "invalid_argument");
}

/** Validates and normalizes the tool's arguments; every refusal here happens before any rule or call row. */
export function normalizeApiRequest(raw: unknown): NormalizedApiRequest {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw invalid("takes an object with method and path");
	}
	const parsed = apiRequestInput.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field = issue?.path.join(".");
		throw invalid(`${field ? `${field}: ` : ""}${issue?.message ?? "invalid arguments"}`);
	}
	const method = parsed.data.method.trim().toUpperCase();
	if (!/^[A-Z]+$/.test(method)) throw invalid("method must be an HTTP method such as GET or POST");
	const path = parsed.data.path.trim();
	if (!path.startsWith("/api/")) {
		throw invalid(
			path.startsWith("/")
				? `only paths under /api are allowed, not ${path}`
				: `path must start with /api/, such as /api/nodes; got ${JSON.stringify(path)}`,
		);
	}
	if (path.includes("?") || path.includes("#")) {
		throw invalid("put query parameters in query, not in path");
	}
	if (path.split("/").some((segment) => segment === "." || segment === "..")) {
		throw invalid("path must not contain . or .. segments");
	}
	if (parsed.data.body !== undefined && (method === "GET" || method === "HEAD")) {
		throw invalid(`${method} requests have no body`);
	}
	let body: string | undefined;
	if (parsed.data.body !== undefined) {
		body = JSON.stringify(bodyValue(parsed.data.body)) ?? "null";
		const bytes = Buffer.byteLength(body, "utf8");
		if (bytes > API_REQUEST_BODY_LIMIT) {
			throw invalid(`the request body is ${bytes} bytes; at most ${API_REQUEST_BODY_LIMIT} are allowed`);
		}
	}
	const query = Object.entries(parsed.data.query ?? {}).map(([name, value]): [string, string] => [name, String(value)]);
	return { method, path, query, body };
}

function routeOf(routes: readonly ApiRoute[], request: NormalizedApiRequest): ApiRoute {
	const route = matchApiRoute(routes, request.method, request.path);
	if (!route) {
		throw new UserError(
			`api_request: no API route ${request.method} ${request.path}; the API reference lists the routes an agent may call`,
			"not_found",
		);
	}
	if (route.agent === "deny") {
		throw new UserError(
			`api_request: the API route ${request.method} ${route.template} is not available to agents`,
			"not_allowed",
		);
	}
	return route;
}

/** The rule operation of one request: its route's agent access decides `api.read` or `api.write`. */
export function apiRequestOperation(routes: readonly ApiRoute[], raw: unknown): Operation {
	const request = normalizeApiRequest(raw);
	const route = routeOf(routes, request);
	return {
		method: route.agent === "allow" ? "api.read" : "api.write",
		target: `${route.method} ${route.template}`,
	};
}

function truncate(text: string): { text: string; truncated: boolean; totalLines: number } {
	const lines = text.split("\n");
	const totalLines = lines.length;
	let kept = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
	let truncated = lines.length > MAX_OUTPUT_LINES;
	if (Buffer.byteLength(kept, "utf8") > MAX_OUTPUT_BYTES) {
		kept = Buffer.from(kept, "utf8")
			.subarray(0, MAX_OUTPUT_BYTES)
			.toString("utf8")
			.replace(/\uFFFD$/, "");
		truncated = true;
	}
	return { text: kept, truncated, totalLines };
}

/** The status line plus the response body: compact JSON, or a description of what was not returned. */
async function renderResponse(response: Response): Promise<{ text: string; isError: boolean }> {
	const status = `HTTP ${response.status}`;
	const type = (response.headers.get("content-type") ?? "").toLowerCase();
	let body: string;
	if (type.includes("text/event-stream")) {
		// A one-shot call cannot follow an event stream, and reading it would never end.
		body = `[event stream${type === "" ? "" : ` ${type}`}; not read]`;
	} else if (type.includes("json")) {
		const raw = await response.text();
		try {
			body = JSON.stringify(JSON.parse(raw));
		} catch {
			body = raw;
		}
	} else {
		const bytes = (await response.arrayBuffer()).byteLength;
		body = `[${type === "" ? "unknown content type" : type}, ${bytes} bytes; not returned]`;
	}
	const text = body === "" ? status : `${status}\n${body}`;
	const cut = truncate(text);
	return {
		text: cut.truncated
			? `${cut.text}\n\n[response truncated to ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES} bytes of ${cut.totalLines} lines; narrow the request]`
			: cut.text,
		isError: !response.ok,
	};
}

export interface ApiRequestActor {
	type: string;
	id: string;
	onBehalfOfUserId: string;
}

/**
 * Runs one validated request through the app's router as the session owner, with the session as the audit
 * actor. The identity travels in the request's bindings, which no header can set.
 */
export async function runApiRequest(
	request: (input: Request, identity: InternalRequestIdentity) => Promise<Response>,
	routes: readonly ApiRoute[],
	raw: unknown,
	actor: ApiRequestActor,
): Promise<CallToolResult> {
	const parsed = normalizeApiRequest(raw);
	const route = routeOf(routes, parsed);
	const query = new URLSearchParams(parsed.query).toString();
	const url = `http://crh.internal${parsed.path}${query === "" ? "" : `?${query}`}`;
	const headers: Record<string, string> = { accept: "application/json" };
	if (parsed.body !== undefined) headers["content-type"] = "application/json";
	const response = await request(
		new Request(url, {
			method: route.method,
			headers,
			...(parsed.body === undefined ? {} : { body: parsed.body }),
		}),
		{
			userId: actor.onBehalfOfUserId,
			actor: { type: actor.type, id: actor.id },
		},
	);
	const rendered = await renderResponse(response);
	return {
		content: [{ type: "text", text: rendered.text }],
		...(rendered.isError ? { isError: true } : {}),
	};
}

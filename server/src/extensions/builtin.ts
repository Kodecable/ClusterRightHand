import type { Operation } from "@crh/api";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { InternalRequestIdentity } from "../api/context.ts";
import { UserError } from "../util/errors.ts";
import { type ApiDocumentLike, type ApiReference, buildApiReference } from "./api-reference.ts";
import { apiRequestOperation, runApiRequest } from "./api-request.ts";
import {
	closeDocumentPaths,
	closeSectionHeadings,
	DOC_PAGE_LINES,
	type DocDocument,
	findDocument,
	findSection,
	loadDocs,
	pageDocument,
	searchDocs,
} from "./docs.ts";
import { defaultDocsRoot } from "./docs-source.ts";
import {
	type ExtensionCallContext,
	type ExtensionTool,
	ExtensionToolError,
	ExtensionUnavailableError,
} from "./model.ts";

/**
 * The built-in extension providers (doc/design/extensions.md "Built-in extensions"). A provider is code
 * that ships with crhs: `docs` serves the documentation and the API reference, `api` runs one API request
 * as the session owner. Their rows live in the same `extensions` table as MCP servers, so an administrator
 * can disable one, change its availability or turn "list directly" off like any other extension.
 *
 * A provider states its own rule operations, which is what lets `api_request` become an `api.read`/`api.write`
 * operation on the request's route rather than an `ext.*` one. `createApp` configures the API document and the
 * router here once all routes are mounted; the documentation index is built lazily from the doc tree.
 */

export interface BuiltinExtensionProvider {
	/** The extension's stable name; also the reserved extension name. */
	readonly name: string;
	/** The description shown to the model when the row has none of its own. */
	readonly description: string;
	/** The tools of the running crhs version; recomputed, so it cannot describe another version. */
	tools(): readonly ExtensionTool[];
	call(tool: string, args: Record<string, unknown>, context: ExtensionCallContext): Promise<unknown>;
	/** The rule operation of one call (doc/design/extensions.md "Rules and approvals"). */
	operation(tool: string, args: Record<string, unknown>): Operation;
}

const DOCS_DESCRIPTION = "The documentation and the API reference of this crhs version";
const API_DESCRIPTION = "The crhs API as the session owner, through the same routes and rules as the WebUI";

const SEARCH_DOCS_INPUT = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: 'Keywords to find, such as "extension approval" or "session rules"',
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 20,
			description: "How many sections to return (default 5, at most 20)",
		},
	},
	required: ["query"],
};

const READ_DOC_INPUT = {
	type: "object",
	properties: {
		path: {
			type: "string",
			description: 'The document path as search_docs returns it, such as "design/extensions.md" or "api/nodes.md"',
		},
		section: {
			type: "string",
			description: "A heading or its anchor; omit to read the whole document",
		},
		offset: { type: "integer", minimum: 1, description: "Line to start at (1-based; default 1)" },
		limit: {
			type: "integer",
			minimum: 1,
			maximum: DOC_PAGE_LINES,
			description: `Lines to read (default ${DOC_PAGE_LINES})`,
		},
	},
	required: ["path"],
};

const API_REQUEST_INPUT = {
	type: "object",
	properties: {
		method: { type: "string", description: "HTTP method: GET, POST, PUT, PATCH or DELETE" },
		path: { type: "string", description: 'The API path, such as "/api/nodes" or "/api/nodes/<id>"' },
		query: {
			type: "object",
			description: "Query parameters as a JSON object of names to strings, numbers or booleans",
			additionalProperties: { type: ["string", "number", "boolean"] },
		},
		body: {
			type: ["object", "array"],
			description: "The JSON request body as an object (not a string holding JSON); at most 1 MiB",
		},
	},
	required: ["method", "path"],
};

const DOCS_TOOLS: readonly ExtensionTool[] = [
	{
		name: "search_docs",
		title: "Search the documentation",
		description:
			"Search the crhs documentation and API reference by keyword. Returns the best sections with their path, " +
			"heading and a short snippet; read one with read_doc.",
		inputSchema: SEARCH_DOCS_INPUT,
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
	{
		name: "read_doc",
		title: "Read a document",
		description:
			"Read one document or one section of it by path, optionally with a section heading or anchor; long " +
			"content is paged with offset and limit.",
		inputSchema: READ_DOC_INPUT,
		annotations: { readOnlyHint: true, idempotentHint: true },
	},
];

const API_TOOLS: readonly ExtensionTool[] = [
	{
		name: "api_request",
		title: "Make an API request",
		description:
			"Call one crhs API route as the session owner, through the same route definitions, access checks and " +
			"rules as the WebUI. Returns the status and the JSON response, or a description of a binary response.",
		inputSchema: API_REQUEST_INPUT,
		annotations: null,
	},
];

/** The API document and router `createApp` hands to the built-in extensions once every route is mounted. */
export interface BuiltinApi {
	document: ApiDocumentLike;
	request: (input: Request, identity: InternalRequestIdentity) => Promise<Response>;
}

export interface BuiltinOptions {
	api?: BuiltinApi;
	/** Overrides the running version's doc tree; tests point at a fixture. */
	docsRoot?: string;
}

interface BuiltinState {
	docsRoot: string;
	api?: { request: BuiltinApi["request"]; reference: ApiReference };
}

let state: BuiltinState = { docsRoot: defaultDocsRoot() };
let documentCache: Promise<DocDocument[]> | undefined;

/** Called by `createApp` once the routes exist, and by tests that need a controlled API or doc tree. */
export function configureBuiltinExtensions(options: BuiltinOptions = {}): void {
	state = {
		docsRoot: options.docsRoot ?? defaultDocsRoot(),
		...(options.api
			? {
					api: {
						request: options.api.request,
						reference: buildApiReference(options.api.document),
					},
				}
			: {}),
	};
	documentCache = undefined;
}

function builtinDocuments(): Promise<DocDocument[]> {
	documentCache ??= loadDocs(state.docsRoot, state.api?.reference).catch((err: unknown) => {
		documentCache = undefined;
		throw err;
	});
	return documentCache;
}

function textResult(...parts: string[]): CallToolResult {
	return {
		content: parts.filter((part) => part !== "").map((text) => ({ type: "text" as const, text })),
	};
}

function integer(value: unknown, what: string, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new UserError(`${what} must be an integer of at least ${min}`, "invalid_argument");
	}
	return Math.min(value, max);
}

async function searchDocsCall(args: Record<string, unknown>): Promise<CallToolResult> {
	const query = typeof args.query === "string" ? args.query.trim() : "";
	if (query === "") throw new UserError('search_docs needs a query, such as "extension approval"', "invalid_argument");
	const limit = integer(args.limit, "limit", 5, 1, 20);
	const results = searchDocs(await builtinDocuments(), query, limit);
	if (results.length === 0) {
		return textResult(
			`No documentation section matched ${JSON.stringify(query)}.`,
			"[docs search: no match; try fewer or different keywords]",
		);
	}
	const lines = results.map(
		(result, index) => `${index + 1}. ${result.path}#${result.heading} — ${result.headingText}\n   ${result.snippet}`,
	);
	const first = results[0] as (typeof results)[number];
	return textResult(
		lines.join("\n\n"),
		`[docs search: ${results.length} section${results.length === 1 ? "" : "s"} for ${JSON.stringify(query)}; ` +
			`read one with read_doc(${JSON.stringify(first.path)}, ${JSON.stringify(first.heading)})]`,
	);
}

async function readDocCall(args: Record<string, unknown>): Promise<CallToolResult> {
	const path = typeof args.path === "string" ? args.path.trim() : "";
	if (path === "") throw new UserError("read_doc needs a path such as design/extensions.md", "invalid_argument");
	const loaded = await builtinDocuments();
	const document = findDocument(loaded, path);
	if (!document) {
		const close = closeDocumentPaths(loaded, path);
		throw new UserError(
			`no documentation at ${JSON.stringify(path)}${close.length === 0 ? "" : `; close matches: ${close.join(", ")}`}`,
			"not_found",
		);
	}
	let section: ReturnType<typeof findSection>;
	if (args.section !== undefined) {
		if (typeof args.section !== "string") throw new UserError("section must be a string", "invalid_argument");
		const wanted = args.section.trim();
		if (wanted === "") throw new UserError("section must not be empty", "invalid_argument");
		section = findSection(document, wanted);
		if (!section) {
			const close = closeSectionHeadings(document, wanted);
			throw new UserError(
				`${document.path} has no section ${JSON.stringify(wanted)}${
					close.length === 0 ? "" : `; close headings: ${close.join("; ")}`
				}`,
				"not_found",
			);
		}
	}
	const offset = integer(args.offset, "offset", 1, 1, Number.MAX_SAFE_INTEGER);
	const limit = integer(args.limit, "limit", DOC_PAGE_LINES, 1, DOC_PAGE_LINES);
	const page = pageDocument(document, section, offset, limit);
	return textResult(page.output, page.note);
}

/** The documentation: `search_docs` and `read_doc`. */
const docs: BuiltinExtensionProvider = {
	name: "docs",
	description: DOCS_DESCRIPTION,
	tools: () => DOCS_TOOLS,
	async call(tool, args) {
		if (tool === "search_docs") return searchDocsCall(args);
		if (tool === "read_doc") return readDocCall(args);
		throw new ExtensionToolError(`the docs extension has no tool named ${tool}`);
	},
	operation: (tool) => ({ method: "ext.read", target: `docs/${tool}` }),
};

/** The crhs API: `api_request`, which states its own `api.read`/`api.write` operation on the route. */
const api: BuiltinExtensionProvider = {
	name: "api",
	description: API_DESCRIPTION,
	tools: () => API_TOOLS,
	async call(tool, args, context) {
		if (tool !== "api_request") throw new ExtensionToolError(`the api extension has no tool named ${tool}`);
		if (!state.api) throw new ExtensionUnavailableError("the api extension is not available in this process");
		const actor = context.builtin?.actor;
		if (!actor) throw new ExtensionUnavailableError("the api extension needs an agent session");
		return runApiRequest(state.api.request, state.api.reference.routes, args, actor);
	},
	operation(tool, args) {
		if (tool !== "api_request") return { method: "ext.write", target: `api/${tool}` };
		if (!state.api) throw new UserError("the api extension is not available in this process", "unavailable");
		return apiRequestOperation(state.api.reference.routes, args);
	},
};

/** The built-in extensions this crhs ships; the names `docs` and `api` are reserved for them. */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtensionProvider[] = [docs, api];

/** The reserved names, for validation when an MCP extension is created. */
export const RESERVED_EXTENSION_NAMES: ReadonlySet<string> = new Set(BUILTIN_EXTENSIONS.map((entry) => entry.name));

export function builtinProvider(name: string): BuiltinExtensionProvider | undefined {
	return BUILTIN_EXTENSIONS.find((entry) => entry.name === name);
}

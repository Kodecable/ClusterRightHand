/**
 * The API reference the `crhs-docs` extension offers (doc/design/extensions.md "Documentation"): the OpenAPI
 * document of the running app rendered into Markdown, one page per tag, plus one page of the shared object
 * shapes. Only routes an agent may call are shown (`allow` and `ask`); a `deny` route is left out, so the
 * model is not shown what it cannot use. The route index built here is also what `api_request` matches on.
 */

import { escapeRegExp } from "../util/regex.ts";

/** The same OpenAPI extension `api/openapi.ts` writes; kept local so `extensions/` has no runtime edge to `api/`. */
const AGENT_ACCESS_EXTENSION = "x-crh-agent";

export interface OpenApiSchema {
	$ref?: string;
	type?: string | string[];
	description?: string;
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, OpenApiSchema>;
	required?: string[];
	items?: OpenApiSchema;
	oneOf?: OpenApiSchema[];
	anyOf?: OpenApiSchema[];
	allOf?: OpenApiSchema[];
	additionalProperties?: boolean | OpenApiSchema;
	nullable?: boolean;
}

export interface OpenApiParameter {
	name?: string;
	in?: string;
	required?: boolean;
	description?: string;
	schema?: OpenApiSchema;
}

export interface OpenApiOperation {
	tags?: string[];
	summary?: string;
	description?: string;
	parameters?: OpenApiParameter[];
	requestBody?: { required?: boolean; content?: Record<string, { schema?: OpenApiSchema }> };
	responses?: Record<string, { description?: string; content?: Record<string, { schema?: OpenApiSchema }> }>;
	/** The vendor extension (`x-crh-agent`) and anything else the document carries. */
	[key: string]: unknown;
}

export interface ApiDocumentLike {
	/** The generated document's path items; the method operations are read as {@link OpenApiOperation}. */
	paths?: Record<string, unknown>;
	components?: { schemas?: Record<string, unknown> };
}

export type AgentAccess = "allow" | "ask" | "deny";

/** One route of the API document, with the pattern `api_request` matches a concrete path against. */
export interface ApiRoute {
	method: string;
	template: string;
	agent: AgentAccess;
	summary: string;
	operation: OpenApiOperation;
	pattern: RegExp;
}

/** The rendered API reference: the routes for matching, and the Markdown pages by virtual path. */
export interface ApiReference {
	routes: ApiRoute[];
	/** `api/<tag-slug>.md` and, when there are shapes, `api/schemas.md`. */
	pages: Map<string, string>;
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/** A route template (`/api/nodes/{id}`) as the pattern a concrete path matches. */
export function routePattern(template: string): RegExp {
	const body = template
		.split("/")
		.map((segment) => (/^\{[^/{}]+\}$/.test(segment) ? "[^/]+" : escapeRegExp(segment)))
		.join("/");
	return new RegExp(`^${body}$`);
}

/** Every operation of the document, `deny` included: matching needs those too, to refuse them clearly. */
export function apiRoutes(document: ApiDocumentLike): ApiRoute[] {
	const routes: ApiRoute[] = [];
	for (const [template, item] of Object.entries(document.paths ?? {})) {
		if (!template.startsWith("/api/")) continue;
		const pathItem = item as Record<string, unknown> | undefined;
		for (const method of METHODS) {
			const operation = pathItem?.[method] as OpenApiOperation | undefined;
			if (!operation) continue;
			const declared = operation[AGENT_ACCESS_EXTENSION as keyof OpenApiOperation];
			const agent: AgentAccess = declared === "allow" || declared === "ask" ? declared : "deny";
			routes.push({
				method: method.toUpperCase(),
				template,
				agent,
				summary: operation.summary ?? "",
				operation,
				pattern: routePattern(template),
			});
		}
	}
	return routes;
}

function parameterCount(template: string): number {
	return template.split("/").filter((segment) => /^\{[^/{}]+\}$/.test(segment)).length;
}

/** The route a concrete method and path call: the most literal template wins over a parameterised one. */
export function matchApiRoute(routes: readonly ApiRoute[], method: string, path: string): ApiRoute | undefined {
	const candidates = routes.filter((route) => route.method === method && route.pattern.test(path));
	candidates.sort(
		(left, right) =>
			parameterCount(left.template) - parameterCount(right.template) || right.template.length - left.template.length,
	);
	return candidates[0];
}

/** A tag's virtual page name: lower-case words joined with `-`. */
export function apiTagSlug(tag: string): string {
	return (
		tag
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "other"
	);
}

function refName(ref: string): string | undefined {
	const name = ref.split("/").at(-1);
	return name === undefined || name === "" ? undefined : name;
}

function oneLine(text: string | undefined, max = 400): string {
	if (!text) return "";
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A schema's type in one compact phrase; a `$ref` is its component name. */
export function schemaType(schema: OpenApiSchema | undefined, depth = 0): string {
	if (!schema) return "value";
	if (schema.$ref) return refName(schema.$ref) ?? "object";
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.enum !== undefined) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
	if (schema.oneOf !== undefined && depth < 3) {
		return [...new Set(schema.oneOf.map((entry) => schemaType(entry, depth + 1)))].join(" | ");
	}
	if (schema.anyOf !== undefined && depth < 3) {
		return [...new Set(schema.anyOf.map((entry) => schemaType(entry, depth + 1)))].join(" | ");
	}
	if (schema.allOf !== undefined && depth < 3) {
		return [...new Set(schema.allOf.map((entry) => schemaType(entry, depth + 1)))].join(" & ");
	}
	const types = Array.isArray(schema.type) ? [...schema.type] : schema.type === undefined ? [] : [schema.type];
	if (types.includes("array") || schema.items !== undefined) {
		const nullSuffix = types.includes("null") ? " | null" : "";
		return `array of ${schema.items ? schemaType(schema.items, depth + 1) : "value"}${nullSuffix}`;
	}
	if (schema.nullable === true && !types.includes("null")) types.push("null");
	if (types.includes("object") || schema.properties !== undefined) {
		return types.includes("null") ? "object | null" : "object";
	}
	return types.length > 0 ? types.join(" | ") : "value";
}

/** Adds every component a schema references, recursively, to `into`. */
function collectRefs(
	schema: OpenApiSchema | undefined,
	components: Record<string, OpenApiSchema>,
	into: Set<string>,
): void {
	if (!schema) return;
	if (schema.$ref !== undefined) {
		const name = refName(schema.$ref);
		if (name === undefined || into.has(name)) return;
		into.add(name);
		collectRefs(components[name], components, into);
		return;
	}
	collectRefs(schema.items, components, into);
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === "object") {
		collectRefs(schema.additionalProperties, components, into);
	}
	for (const child of schema.oneOf ?? []) collectRefs(child, components, into);
	for (const child of schema.anyOf ?? []) collectRefs(child, components, into);
	for (const child of schema.allOf ?? []) collectRefs(child, components, into);
	for (const child of Object.values(schema.properties ?? {})) collectRefs(child, components, into);
}

function resolveSchema(
	schema: OpenApiSchema | undefined,
	components: Record<string, OpenApiSchema>,
): { schema: OpenApiSchema | undefined; name: string | undefined } {
	if (schema?.$ref !== undefined) {
		const name = refName(schema.$ref);
		return { schema: name === undefined ? undefined : components[name], name };
	}
	return { schema, name: undefined };
}

/** The top-level fields of an object schema, one line each. */
function fieldLines(schema: OpenApiSchema | undefined): string[] {
	if (!schema?.properties) return [];
	const required = new Set(schema.required ?? []);
	return Object.entries(schema.properties).map(([name, property]) => {
		const description = oneLine(property.description);
		return `- \`${name}\`: ${schemaType(property)}${required.has(name) ? " (required)" : " (optional)"}${
			description === "" ? "" : ` — ${description}`
		}`;
	});
}

function parameterLines(parameters: readonly OpenApiParameter[] | undefined): string[] {
	const lines: string[] = [];
	for (const parameter of parameters ?? []) {
		if (parameter.in !== "path" && parameter.in !== "query") continue;
		if (!parameter.name) continue;
		const description = oneLine(parameter.description ?? parameter.schema?.description);
		lines.push(
			`- \`${parameter.name}\` (${parameter.in}, ${schemaType(parameter.schema)}, ${
				parameter.required === true ? "required" : "optional"
			})${description === "" ? "" : ` — ${description}`}`,
		);
	}
	return lines;
}

function jsonSchema(content: OpenApiOperation["requestBody"]): OpenApiSchema | undefined {
	return content?.content?.["application/json"]?.schema;
}

function bodyLines(operation: OpenApiOperation, components: Record<string, OpenApiSchema>): string[] {
	const body = operation.requestBody;
	if (!body) return [];
	const raw = jsonSchema(body);
	if (!raw) {
		const types = Object.keys(body.content ?? {});
		return [`Body: ${types.length === 0 ? "none" : types.join(", ")}${body.required === true ? " (required)" : ""}`];
	}
	const { schema, name } = resolveSchema(raw, components);
	const label = `Body${name === undefined ? "" : ` (${name})`}${body.required === true ? " (required)" : ""}:`;
	const fields = fieldLines(schema);
	return [label, ...(fields.length > 0 ? fields : [`- ${schemaType(raw)}`])];
}

function responseLines(operation: OpenApiOperation, components: Record<string, OpenApiSchema>): string[] {
	const lines: string[] = [];
	for (const [status, response] of Object.entries(operation.responses ?? {})) {
		if (!/^2\d\d$/.test(status)) continue;
		const content = response.content?.["application/json"];
		const raw = content?.schema;
		if (!raw) {
			const types = Object.keys(response.content ?? {});
			lines.push(`- ${status}: ${types.length === 0 ? "no body" : types.join(", ")}`);
			continue;
		}
		const { schema, name } = resolveSchema(raw, components);
		const fields = fieldLines(schema);
		if (fields.length === 0) {
			lines.push(`- ${status}: ${schemaType(raw)}`);
			continue;
		}
		lines.push(`- ${status}${name === undefined ? "" : ` (${name})`}:`);
		for (const field of fields) lines.push(`  ${field}`);
	}
	return lines;
}

function renderOperation(route: ApiRoute, components: Record<string, OpenApiSchema>): string[] {
	const lines: string[] = [`## ${route.method} ${route.template}`, ""];
	const summary = oneLine(route.summary);
	if (summary !== "") lines.push(summary, "");
	lines.push(
		`Agent access: ${
			route.agent === "allow" ? "read (allow)" : "needs approval (write, ask)"
		}; rules match \`${route.method} ${route.template}\`.`,
		"",
	);
	const parameters = parameterLines(route.operation.parameters);
	if (parameters.length > 0) lines.push("Parameters:", ...parameters, "");
	const body = bodyLines(route.operation, components);
	if (body.length > 0) lines.push(...body, "");
	const responses = responseLines(route.operation, components);
	if (responses.length > 0) lines.push("Responses:", ...responses);
	return lines;
}

function renderSchema(name: string, schema: OpenApiSchema): string[] {
	const lines: string[] = [`## ${name}`, ""];
	const description = oneLine(schema.description);
	if (description !== "") lines.push(description, "");
	const fields = fieldLines(schema);
	if (fields.length > 0) lines.push(...fields, "");
	else lines.push(`Type: ${schemaType(schema)}`, "");
	return lines;
}

/**
 * Renders the reference. Operation schemas, parameters and 2xx responses of the included routes are walked
 * for component references, so `api/schemas.md` holds each shared shape once and only when it is used.
 */
export function buildApiReference(document: ApiDocumentLike): ApiReference {
	const routes = apiRoutes(document);
	const components = (document.components?.schemas ?? {}) as Record<string, OpenApiSchema>;
	const included = routes.filter((route) => route.agent !== "deny");

	const referenced = new Set<string>();
	for (const route of included) {
		for (const parameter of route.operation.parameters ?? []) collectRefs(parameter.schema, components, referenced);
		collectRefs(jsonSchema(route.operation.requestBody), components, referenced);
		for (const [status, response] of Object.entries(route.operation.responses ?? {})) {
			if (!/^2\d\d$/.test(status)) continue;
			collectRefs(response.content?.["application/json"]?.schema, components, referenced);
		}
	}

	const byTag = new Map<string, ApiRoute[]>();
	for (const route of included) {
		for (const tag of route.operation.tags ?? ["Other"]) {
			const list = byTag.get(tag) ?? [];
			list.push(route);
			byTag.set(tag, list);
		}
	}

	const pages = new Map<string, string>();
	const usedSlugs = new Map<string, string>();
	for (const [tag, tagRoutes] of [...byTag.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		let slug = apiTagSlug(tag);
		for (let suffix = 2; usedSlugs.has(slug) && usedSlugs.get(slug) !== tag; suffix += 1)
			slug = `${apiTagSlug(tag)}-${suffix}`;
		usedSlugs.set(slug, tag);
		const lines = [`# ${tag}`, "", `crhs API operations tagged ${tag} that an agent may call.`, ""];
		for (const route of tagRoutes) lines.push(...renderOperation(route, components));
		pages.set(`api/${slug}.md`, `${lines.join("\n").trimEnd()}\n`);
	}

	if (referenced.size > 0) {
		const lines = [
			"# Shared API schemas",
			"",
			"The object shapes used by the API operations above, each described once.",
			"",
		];
		for (const name of [...referenced].sort()) {
			const schema = components[name];
			if (schema) lines.push(...renderSchema(name, schema));
		}
		pages.set("api/schemas.md", `${lines.join("\n").trimEnd()}\n`);
	}

	return { routes, pages };
}

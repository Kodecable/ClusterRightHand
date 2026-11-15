import type { ExtensionInput } from "@crh/api";
import {
	ExtensionInputSchema,
	ExtensionListResponseSchema,
	ExtensionNameParamSchema,
	ExtensionResponseSchema,
	ExtensionStatusResponseSchema,
	ExtensionToolsErrorSchema,
	ExtensionToolsResponseSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import type { McpConnections } from "../extensions/connections.ts";
import type { ExtensionTool } from "../extensions/model.ts";
import { extensionOf } from "../extensions/registry.ts";
import {
	deleteExtension,
	type ExtensionRow,
	extensionView,
	getExtensionRow,
	listExtensionRows,
	saveExtension,
} from "../extensions/store.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { redactUrlsInText, urlWithoutSecrets } from "../util/url.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["Extensions"];

const listRoute = defineRoute({
	method: "get",
	path: "/extensions",
	tags: TAGS,
	summary: "List the extensions of both kinds; header values are never returned (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	responses: { 200: { description: "The extensions", ...json(ExtensionListResponseSchema) } },
});

const saveRoute = defineRoute({
	method: "put",
	path: "/extensions/{name}",
	tags: TAGS,
	summary: "Create or replace an MCP extension, or change a built-in's settings (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ExtensionNameParamSchema, body: { required: true, ...json(ExtensionInputSchema) } },
	responses: { 200: { description: "The saved extension", ...json(ExtensionResponseSchema) } },
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/extensions/{name}",
	tags: TAGS,
	summary: "Delete an MCP extension, its stored headers and its grants (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ExtensionNameParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

const toolsRoute = defineRoute({
	method: "get",
	path: "/extensions/{name}/tools",
	tags: TAGS,
	summary: "List an extension's tools, connecting an MCP server first (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ExtensionNameParamSchema },
	responses: {
		200: { description: "The tools and the state", ...json(ExtensionToolsResponseSchema) },
		502: { description: "The MCP server could not be reached", ...json(ExtensionToolsErrorSchema) },
	},
});

const reconnectRoute = defineRoute({
	method: "post",
	path: "/extensions/{name}/reconnect",
	tags: TAGS,
	summary: "Reconnect an MCP extension now instead of waiting for the next backoff attempt (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: ExtensionNameParamSchema },
	responses: { 200: { description: "The connection state", ...json(ExtensionStatusResponseSchema) } },
});

export interface ExtensionRoutesOptions {
	masterKey: MasterKey;
	connections: McpConnections;
	/** Reinstalls a changed extension's direct tools in the agent runtime. */
	onExtensionChanged?: (row: ExtensionRow, tools: readonly ExtensionTool[]) => void;
	/** Removes a deleted extension's direct tools. */
	onExtensionDeleted?: (name: string) => void;
}

/**
 * The administrator's extensions (doc/design/extensions.md "Extensions"): create, edit and delete MCP
 * extensions, change a built-in's enabled/list directly/availability/grants/description and view its tools.
 * Header values are write-only; the view reports only which headers are stored. Every change is audited as
 * configuration without header values. Requires a WebUI session and an administrator.
 */
export function extensionRoutes(db: Db, options: ExtensionRoutesOptions) {
	const app = apiRouter();

	const toolsOf = (row: ExtensionRow): readonly ExtensionTool[] => extensionOf(row, options.connections)?.tools() ?? [];

	const views = async () => {
		const rows = await listExtensionRows(db);
		return Promise.all(
			rows.map((row) => {
				const extension = extensionOf(row, options.connections);
				const status = extension?.status() ?? {
					state: "unavailable" as const,
					lastError: "this extension is not available in this crhs",
					nextAttemptAt: null,
					toolCount: 0,
				};
				return extensionView(db, options.masterKey, row, status);
			}),
		);
	};

	app.openapi(listRoute, async (c) => {
		return c.json({ extensions: await views() }, 200);
	});

	app.openapi(saveRoute, async (c) => {
		const { name } = c.req.valid("param");
		const input: ExtensionInput = c.req.valid("json");
		const { row, created } = await saveExtension(db, options.masterKey, name, input, c.get("user").userId);
		// The old connection used the old URL and headers; the next use connects afresh. The last known tool
		// list stays, so a run of setting changes does not hide the extension's direct tools meanwhile.
		if (row.kind === "mcp") await options.connections.invalidate(row.name, { keepTools: true });
		options.onExtensionChanged?.(row, toolsOf(row));
		const view = await extensionView(
			db,
			options.masterKey,
			row,
			extensionOf(row, options.connections)?.status() ?? {
				state: "unavailable",
				lastError: "this extension is not available in this crhs",
				nextAttemptAt: null,
				toolCount: 0,
			},
		);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: created ? "extension.created" : "extension.updated",
			target: { type: "extension", id: row.name },
			// Header values are never recorded, only their names. An MCP URL often carries a credential in its
			// query, so only the scheme, host and path are recorded.
			detail: {
				kind: row.kind,
				url: row.url === null ? null : urlWithoutSecrets(row.url),
				enabled: row.enabled === 1,
				list_directly: row.list_directly === 1,
				availability: row.availability,
				trust_annotations: row.trust_annotations === null ? null : row.trust_annotations === 1,
				timeout_seconds: row.timeout_ms === null ? null : row.timeout_ms / 1000,
				header_names: view.headerNames,
				identity_headers: view.identityHeaders,
				grants: view.grants,
			},
		});
		return c.json({ extension: view }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const { name } = c.req.valid("param");
		const row = await getExtensionRow(db, name);
		if (!row) throw new NotFoundError("no such extension");
		await deleteExtension(db, name);
		if (row.kind === "mcp") await options.connections.invalidate(name);
		options.onExtensionDeleted?.(name);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "extension.deleted",
			target: { type: "extension", id: name },
			detail: { kind: row.kind },
		});
		return c.json({ ok: true as const }, 200);
	});

	/** Test: connect an MCP extension now and list its tools; a built-in's tools are always available. */
	app.openapi(toolsRoute, async (c) => {
		const { name } = c.req.valid("param");
		const row = await getExtensionRow(db, name);
		if (!row) throw new NotFoundError("no such extension");
		if (row.kind === "builtin") {
			const extension = extensionOf(row, options.connections);
			if (!extension) throw new NotFoundError("no such extension");
			return c.json({ tools: [...extension.tools()], status: extension.status() }, 200);
		}
		try {
			await options.connections.refreshTools(name);
		} catch (err) {
			throw new HTTPException(502, {
				res: c.json({ error: redactUrlsInText((err as Error).message), status: options.connections.status(name) }, 502),
			});
		}
		const tools = options.connections.tools(name).map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
		}));
		return c.json({ tools, status: options.connections.status(name) }, 200);
	});

	/** Reconnect now, instead of waiting for the next backoff attempt. */
	app.openapi(reconnectRoute, async (c) => {
		const { name } = c.req.valid("param");
		const row = await getExtensionRow(db, name);
		if (!row) throw new NotFoundError("no such extension");
		if (row.kind === "builtin") throw new UserError("built-in extensions have no connection and are always ready");
		const status = await options.connections.reconnect(name);
		return c.json({ status }, 200);
	});

	return app;
}

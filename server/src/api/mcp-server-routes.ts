import type { McpServerInput } from "@crh/api";
import {
	McpServerInputSchema,
	McpServerListResponseSchema,
	McpServerNameParamSchema,
	McpServerResponseSchema,
	McpServerStatusResponseSchema,
	McpServerToolsErrorSchema,
	McpServerToolsResponseSchema,
	OkResponseSchema,
} from "@crh/api/schemas";
import { HTTPException } from "hono/http-exception";
import { userActor } from "../audit/audit.ts";
import type { McpConnections } from "../extensions/connections.ts";
import {
	deleteMcpServer,
	getMcpServerRow,
	listMcpServerRows,
	type McpServerRow,
	mcpServerView,
	saveMcpServer,
} from "../extensions/servers.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError } from "../util/errors.ts";
import { requireAdmin } from "./middleware.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";

const TAGS = ["MCP servers"];

const listRoute = defineRoute({
	method: "get",
	path: "/mcp-servers",
	tags: TAGS,
	summary: "List the connected MCP servers; header values are never returned (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	responses: { 200: { description: "The servers", ...json(McpServerListResponseSchema) } },
});

const saveRoute = defineRoute({
	method: "put",
	path: "/mcp-servers/{name}",
	tags: TAGS,
	summary: "Create or replace an MCP server, its header values and its grants (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: McpServerNameParamSchema, body: { required: true, ...json(McpServerInputSchema) } },
	responses: { 200: { description: "The saved server", ...json(McpServerResponseSchema) } },
});

const deleteRoute = defineRoute({
	method: "delete",
	path: "/mcp-servers/{name}",
	tags: TAGS,
	summary: "Delete an MCP server, its stored headers and its grants (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: McpServerNameParamSchema },
	responses: { 200: { description: "Deleted", ...json(OkResponseSchema) } },
});

const toolsRoute = defineRoute({
	method: "get",
	path: "/mcp-servers/{name}/tools",
	tags: TAGS,
	summary: "Connect now and list an MCP server's tools, so an administrator can check it (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: McpServerNameParamSchema },
	responses: {
		200: { description: "The tools and the connection status", ...json(McpServerToolsResponseSchema) },
		502: { description: "The server could not be reached", ...json(McpServerToolsErrorSchema) },
	},
});

const reconnectRoute = defineRoute({
	method: "post",
	path: "/mcp-servers/{name}/reconnect",
	tags: TAGS,
	summary: "Reconnect an MCP server now instead of waiting for the next backoff attempt (administrators)",
	agent: "deny",
	middleware: [requireAdmin],
	request: { params: McpServerNameParamSchema },
	responses: { 200: { description: "The connection status", ...json(McpServerStatusResponseSchema) } },
});

export interface McpServerRoutesOptions {
	masterKey: MasterKey;
	connections: McpConnections;
	/** Reinstalls a changed server's direct tools in the agent runtime. */
	onServerChanged?: (row: McpServerRow) => void;
	/** Removes a deleted server's extension. */
	onServerDeleted?: (name: string) => void;
}

/**
 * The administrator's MCP servers (doc/design/extensions.md "MCP servers"): create, edit, delete, test and
 * reconnect. Header values are write-only; the view reports only which headers are stored. Every change is
 * audited as configuration without header values. Requires a WebUI session and an administrator.
 */
export function mcpServerRoutes(db: Db, options: McpServerRoutesOptions) {
	const app = apiRouter();

	const views = async () => {
		const rows = await listMcpServerRows(db);
		return Promise.all(
			rows.map((row) => mcpServerView(db, options.masterKey, row, options.connections.status(row.name))),
		);
	};

	app.openapi(listRoute, async (c) => {
		return c.json({ servers: await views() }, 200);
	});

	app.openapi(saveRoute, async (c) => {
		const { name } = c.req.valid("param");
		const input: McpServerInput = c.req.valid("json");
		const { row, created } = await saveMcpServer(db, options.masterKey, name, input, c.get("user").userId);
		// The old connection used the old URL and headers; the next use connects afresh. The last known tool
		// list stays, so a run of setting changes does not hide the server's direct tools meanwhile.
		await options.connections.invalidate(row.name, { keepTools: true });
		options.onServerChanged?.(row);
		const view = await mcpServerView(db, options.masterKey, row, options.connections.status(row.name));
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: created ? "mcp_server.created" : "mcp_server.updated",
			target: { type: "mcp_server", id: row.name },
			// Header values are never recorded, only their names.
			detail: {
				url: row.url,
				enabled: row.enabled === 1,
				list_directly: row.list_directly === 1,
				trust_annotations: row.trust_annotations === 1,
				timeout_seconds: row.timeout_ms / 1000,
				header_names: view.headerNames,
				identity_headers: view.identityHeaders,
				grants: view.grants,
			},
		});
		return c.json({ server: view }, 200);
	});

	app.openapi(deleteRoute, async (c) => {
		const { name } = c.req.valid("param");
		const row = await getMcpServerRow(db, name);
		if (!row) throw new NotFoundError("no such MCP server");
		await deleteMcpServer(db, name);
		await options.connections.invalidate(name);
		options.onServerDeleted?.(name);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "mcp_server.deleted",
			target: { type: "mcp_server", id: name },
		});
		return c.json({ ok: true as const }, 200);
	});

	/** Test: connect now and list the tools, so the administrator can check a new server. */
	app.openapi(toolsRoute, async (c) => {
		const { name } = c.req.valid("param");
		const row = await getMcpServerRow(db, name);
		if (!row) throw new NotFoundError("no such MCP server");
		try {
			await options.connections.refreshTools(name);
		} catch (err) {
			throw new HTTPException(502, {
				res: c.json({ error: (err as Error).message, status: options.connections.status(name) }, 502),
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
		const row = await getMcpServerRow(db, name);
		if (!row) throw new NotFoundError("no such MCP server");
		const status = await options.connections.reconnect(name);
		return c.json({ status }, 200);
	});

	return app;
}

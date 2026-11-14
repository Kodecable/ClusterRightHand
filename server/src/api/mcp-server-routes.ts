import type { McpServerInput } from "@crh/api";
import { Hono } from "hono";
import { userActor } from "../audit/audit.ts";
import type { McpConnections } from "../extensions/connections.ts";
import type { McpServerRow } from "../extensions/servers.ts";
import {
	deleteMcpServer,
	getMcpServerRow,
	listMcpServerRows,
	mcpServerView,
	saveMcpServer,
} from "../extensions/servers.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireAdmin } from "./middleware.ts";

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
	const app = new Hono<AppEnv>();

	const views = async () => {
		const rows = await listMcpServerRows(db);
		return Promise.all(
			rows.map((row) => mcpServerView(db, options.masterKey, row, options.connections.status(row.name))),
		);
	};

	app.get("/mcp-servers", requireAdmin, async (c) => {
		return c.json({ servers: await views() });
	});

	app.put("/mcp-servers/:name", requireAdmin, async (c) => {
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const input: McpServerInput = {
			url: body.url as string,
			...(Object.hasOwn(body, "description") ? { description: body.description as string | null } : {}),
			...(Object.hasOwn(body, "headers") ? { headers: body.headers as McpServerInput["headers"] } : {}),
			...(Object.hasOwn(body, "identityHeaders")
				? { identityHeaders: body.identityHeaders as McpServerInput["identityHeaders"] }
				: {}),
			...(Object.hasOwn(body, "enabled") ? { enabled: body.enabled as boolean } : {}),
			...(Object.hasOwn(body, "listDirectly") ? { listDirectly: body.listDirectly as boolean } : {}),
			...(Object.hasOwn(body, "trustAnnotations") ? { trustAnnotations: body.trustAnnotations as boolean } : {}),
			...(Object.hasOwn(body, "timeoutSeconds") ? { timeoutSeconds: body.timeoutSeconds as number } : {}),
			...(Object.hasOwn(body, "grants") ? { grants: body.grants as McpServerInput["grants"] } : {}),
		};
		const { row, created } = await saveMcpServer(
			db,
			options.masterKey,
			c.req.param("name"),
			input,
			c.get("user").userId,
		);
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
		return c.json({ server: view });
	});

	app.delete("/mcp-servers/:name", requireAdmin, async (c) => {
		const name = c.req.param("name");
		const row = await getMcpServerRow(db, name);
		if (!row) return jsonError(c, 404, "no such MCP server");
		await deleteMcpServer(db, name);
		await options.connections.invalidate(name);
		options.onServerDeleted?.(name);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "mcp_server.deleted",
			target: { type: "mcp_server", id: name },
		});
		return c.json({ ok: true });
	});

	/** Test: connect now and list the tools, so the administrator can check a new server. */
	app.get("/mcp-servers/:name/tools", requireAdmin, async (c) => {
		const name = c.req.param("name");
		const row = await getMcpServerRow(db, name);
		if (!row) return jsonError(c, 404, "no such MCP server");
		try {
			await options.connections.refreshTools(name);
		} catch (err) {
			return c.json(
				{
					error: (err as Error).message,
					status: options.connections.status(name),
				},
				502,
			);
		}
		const tools = options.connections.tools(name).map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
		}));
		return c.json({ tools, status: options.connections.status(name) });
	});

	/** Reconnect now, instead of waiting for the next backoff attempt. */
	app.post("/mcp-servers/:name/reconnect", requireAdmin, async (c) => {
		const name = c.req.param("name");
		const row = await getMcpServerRow(db, name);
		if (!row) return jsonError(c, 404, "no such MCP server");
		const status = await options.connections.reconnect(name);
		return c.json({ status });
	});

	return app;
}

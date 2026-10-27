import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { Audit } from "../audit/audit.ts";
import { resolveApiToken, type TokenIdentity } from "../auth/api-tokens.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { Db } from "../storage/db.ts";
import { TOOLS, type ToolContext } from "../tools/catalog.ts";
import { NotFoundError, UserError } from "../users/service.ts";

export interface McpOptions {
	cluster: Cluster;
	groups: TaskGroups;
	audit?: Audit;
	/** Version reported to clients. */
	version?: string;
}

/**
 * The MCP facade at /mcp (Streamable HTTP, stateless; doc/mcp.md). Each request carries an API token,
 * which is both the caller's identity and the root of its rule chain.
 */
export function mcpRoutes(db: Db, options: McpOptions): Hono {
	const app = new Hono();
	// The factory runs inside handler.fetch; it finds the request's identity by a per-request key.
	const identities = new Map<string, TokenIdentity & { origin: string }>();
	let requests = 0;

	const handler = createMcpHandler(
		(ctx) => {
			const id = ctx.authInfo ? identities.get(ctx.authInfo.clientId) : undefined;
			if (!id) throw new Error("unauthenticated MCP request");
			return buildServer(db, options, id);
		},
		{ onerror: (err) => console.error("mcp:", err.message) },
	);

	app.all("/mcp", async (c) => {
		const header = c.req.header("authorization") ?? "";
		const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
		const identity = token ? await resolveApiToken(db, token) : undefined;
		if (!token || !identity) {
			return c.json({ error: "a valid API token is required (Authorization: Bearer crh_…)" }, 401, {
				"WWW-Authenticate": 'Bearer realm="crh"',
			});
		}
		const key = `${identity.tokenId}#${++requests}`;
		identities.set(key, { ...identity, origin: new URL(c.req.url).origin });
		try {
			return await handler.fetch(c.req.raw, { authInfo: { token, clientId: key, scopes: [] } });
		} finally {
			identities.delete(key);
		}
	});
	return app;
}

function buildServer(db: Db, options: McpOptions, id: TokenIdentity & { origin: string }): McpServer {
	const server = new McpServer({ name: "clusterrighthand", version: options.version ?? "0.0.0" });
	const ctx: ToolContext = {
		db,
		cluster: options.cluster,
		groups: options.groups,
		user: id.user,
		actor: { type: "api_token", id: id.tokenId, onBehalfOfUserId: id.user.userId },
		chain: [{ type: "api_token", id: id.tokenId }],
		approvalUrl: (kind, taskId) => `${id.origin}/#/approvals/${kind === "task" ? "tasks" : "task-groups"}/${taskId}`,
	};
	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.input,
				annotations: { readOnlyHint: tool.readOnly, openWorldHint: true },
			},
			async (args: unknown) => {
				void options.audit?.record({
					actor: { type: "api_token", id: id.tokenId, onBehalfOfUserId: id.user.userId },
					action: "tool.call",
					target: { type: "tool", id: tool.name },
					detail: { via: "mcp" },
				});
				try {
					const result = await tool.handler(args as never, ctx);
					return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
				} catch (err) {
					// Expected failures go back to the model as tool errors; anything else is a server bug.
					if (!(err instanceof UserError || err instanceof NotFoundError)) throw err;
					return { content: [{ type: "text" as const, text: err.message }], isError: true };
				}
			},
		);
	}
	return server;
}

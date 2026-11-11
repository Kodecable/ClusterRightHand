import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { jsonBodyLimit, MAX_INPUT_BODY_BYTES } from "../api/body-limit.ts";
import type { Audit } from "../audit/audit.ts";
import { resolveApiToken, type TokenIdentity } from "../auth/api-tokens.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { Db } from "../storage/db.ts";
import { callTool } from "../tools/adapter.ts";
import { TOOLS, type ToolContext } from "../tools/catalog.ts";

export interface McpOptions {
	cluster: Cluster;
	taskGroups: TaskGroups;
	audit?: Audit;
	/** Absolute base URL for links; unset builds them from the request URL (`public_url`). */
	publicUrl?: string | null;
	/** Version reported to clients. */
	version?: string;
}

/**
 * The MCP facade at /mcp (Streamable HTTP, stateless; doc/guide/mcp.md). Each request carries an API token,
 * which is both the caller's identity and the root of its rule chain.
 */
export function mcpRoutes(db: Db, options: McpOptions): Hono {
	const app = new Hono();
	// The factory runs inside handler.fetch; it finds the request's identity by a per-request key.
	const identities = new Map<string, TokenIdentity & { baseUrl: string }>();
	let requests = 0;

	const handler = createMcpHandler(
		(ctx) => {
			const id = ctx.authInfo ? identities.get(ctx.authInfo.clientId) : undefined;
			if (!id) throw new Error("unauthenticated MCP request");
			return buildServer(db, options, id);
		},
		{ onerror: (err) => console.error("mcp:", err.message) },
	);

	// A tool call can carry a task's stdin or file content, so /mcp takes the same larger limit as the task
	// input routes (the default 1 MiB limit is skipped for it in app.ts).
	app.all("/mcp", jsonBodyLimit(MAX_INPUT_BODY_BYTES), async (c) => {
		const header = c.req.header("authorization") ?? "";
		const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
		const identity = token ? await resolveApiToken(db, token) : undefined;
		if (!token || !identity) {
			return c.json({ error: "a valid API token is required (Authorization: Bearer crh_…)" }, 401, {
				"WWW-Authenticate": 'Bearer realm="crh"',
			});
		}
		const key = `${identity.tokenId}#${++requests}`;
		// public_url is the console's public base behind a TLS-terminating proxy; without it, the request's
		// origin is the best crhs can know (doc/guide/mcp.md "Limitations").
		const baseUrl = options.publicUrl ?? new URL(c.req.url).origin;
		identities.set(key, { ...identity, baseUrl });
		try {
			return await handler.fetch(c.req.raw, { authInfo: { token, clientId: key, scopes: [] } });
		} finally {
			identities.delete(key);
		}
	});
	return app;
}

function buildServer(db: Db, options: McpOptions, id: TokenIdentity & { baseUrl: string }): McpServer {
	const server = new McpServer({ name: "clusterrighthand", version: options.version ?? "0.0.0" });
	const baseCtx: ToolContext = {
		db,
		cluster: options.cluster,
		taskGroups: options.taskGroups,
		user: id.user,
		actor: { type: "api_token", id: id.tokenId, onBehalfOfUserId: id.user.userId },
		chain: [{ type: "api_token", id: id.tokenId }],
		approvalUrl: (kind, taskId) => `${id.baseUrl}/approvals/${kind === "task" ? "tasks" : "task-groups"}/${taskId}`,
		taskUrl: (taskId) => `${id.baseUrl}/tasks/${taskId}`,
		taskGroupUrl: (taskGroupId) => `${id.baseUrl}/task-groups/${taskGroupId}`,
	};
	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				description: tool.description,
				inputSchema: tool.input,
				annotations: { readOnlyHint: tool.readOnly, openWorldHint: true },
			},
			// The request's abort signal ends a wait; the file tools also cancel their task when it fires
			// (a closed MCP request must not leave a write to run after an approval).
			async (args, extra) => {
				const call = await callTool(
					tool,
					args,
					{ ...baseCtx, signal: extra.mcpReq.signal },
					{
						via: "mcp",
						...(options.audit ? { audit: options.audit } : {}),
					},
				);
				return { content: call.content, isError: call.isError };
			},
		);
	}
	return server;
}

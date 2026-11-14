/**
 * External tools through MCP servers, called "extensions" (doc/design/extensions.md). Administrators
 * connect servers; agent sessions reach their tools through `search_tools` and `call_tool`, and every
 * call goes through the same rules, approvals and audit log as a cluster task.
 */

import type { z } from "zod";
import type {
	ExternalCallStateSchema,
	ExternalCallViewSchema,
	McpServerGrantSchema,
	McpServerHeaderSchema,
	McpServerIdentityHeadersSchema,
	McpServerInputSchema,
	McpServerListResponseSchema,
	McpServerResponseSchema,
	McpServerStateSchema,
	McpServerStatusSchema,
	McpServerToolsResponseSchema,
	McpServerViewSchema,
	McpSessionServerSchema,
	McpToolAnnotationsSchema,
	McpToolViewSchema,
} from "./schemas/extensions.ts";

/** What an administrator may set on an MCP server; `name` comes from the route. */
export type McpServerHeader = z.infer<typeof McpServerHeaderSchema>;

/**
 * The two headers that carry the CRH identity to the server: the user's name and the session id. They are
 * written by crhs on every call and are not authentication.
 */
export type McpServerIdentityHeaders = z.infer<typeof McpServerIdentityHeadersSchema>;

/** How a server's connection currently behaves (doc/design/extensions.md "Connections"). */
export type McpServerState = z.infer<typeof McpServerStateSchema>;

export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

/** One MCP tool as the server listed it. */
export type McpToolView = z.infer<typeof McpToolViewSchema>;

/** The tool annotations rules may use (doc/design/extensions.md "Rules and approvals"). */
export type McpToolAnnotations = z.infer<typeof McpToolAnnotationsSchema>;

export type McpServerGrant = z.infer<typeof McpServerGrantSchema>;

export type McpServerView = z.infer<typeof McpServerViewSchema>;

/** `PUT /api/mcp-servers/:name`; omitted fields keep their value, `headers` null removes them. */
export type McpServerInput = z.infer<typeof McpServerInputSchema>;

export type McpServerListResponse = z.infer<typeof McpServerListResponseSchema>;

export type McpServerResponse = z.infer<typeof McpServerResponseSchema>;

export type McpServerToolsResponse = z.infer<typeof McpServerToolsResponseSchema>;

/** A server as a session's settings and tool guide see it. */
export type McpSessionServer = z.infer<typeof McpSessionServerSchema>;

/** The state of one external tool call (doc/design/extensions.md "External calls"). */
export type ExternalCallState = z.infer<typeof ExternalCallStateSchema>;

/**
 * One external call as the approvals page and the session decision panel show it. The row holds only the
 * state that must survive while the call is in progress, so a terminal call has empty `arguments`; its
 * result is in the transcript and who decided in the audit log.
 */
export type ExternalCallView = z.infer<typeof ExternalCallViewSchema>;

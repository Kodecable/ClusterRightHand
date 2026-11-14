/**
 * External tools through MCP servers, called "extensions" (doc/design/extensions.md). Administrators
 * connect servers; agent sessions reach their tools through `search_tools` and `call_tool`, and every
 * call goes through the same rules, approvals and audit log as a cluster task.
 */

import type { ApprovalRecord, Operation } from "./policy.ts";

/** What an administrator may set on an MCP server; `name` comes from the route. */
export interface McpServerHeader {
	name: string;
	value: string;
}

/**
 * The two headers that carry the CRH identity to the server: the user's name and the session id. They are
 * written by crhs on every call and are not authentication.
 */
export interface McpServerIdentityHeaders {
	username: string | null;
	session: string | null;
}

/** How a server's connection currently behaves (doc/design/extensions.md "Connections"). */
export type McpServerState = "unknown" | "connecting" | "ready" | "unavailable";

export interface McpServerStatus {
	state: McpServerState;
	/** Why the last connection attempt failed; null when it succeeded. */
	lastError: string | null;
	/** When the next automatic attempt happens while unavailable; null when it is not waiting for one. */
	nextAttemptAt: string | null;
	/** Tools of the last successful listing; 0 before the first one. */
	toolCount: number;
}

/** One MCP tool as the server listed it. */
export interface McpToolView {
	name: string;
	title: string | null;
	description: string | null;
	/** The tool's JSON input schema, passed to the model unchanged. */
	inputSchema: unknown;
	annotations: McpToolAnnotations | null;
}

/** The tool annotations rules may use (doc/design/extensions.md "Rules and approvals"). */
export interface McpToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface McpServerGrant {
	granteeType: "user" | "user_group";
	granteeId: string;
}

export interface McpServerView {
	id: string;
	name: string;
	/** Shown to the model with the server; falls back to the server's own instructions. */
	description: string | null;
	url: string;
	/** Whether headers are stored; their values are never returned. */
	hasHeaders: boolean;
	/** The stored header names, for display only. */
	headerNames: string[];
	identityHeaders: McpServerIdentityHeaders;
	enabled: boolean;
	/** Its tools appear in the model's tool list as mcp__<server>__<tool> instead of only through search. */
	listDirectly: boolean;
	/** Use the server's readOnlyHint for rules, instead of treating every tool as a write. */
	trustAnnotations: boolean;
	/** Per call; a longer one also protects a slow server (5 minutes by default). */
	timeoutSeconds: number;
	grants: McpServerGrant[];
	status: McpServerStatus;
	createdAt: string;
	updatedAt: string;
}

/** `PUT /api/mcp-servers/:name`; omitted fields keep their value, `headers` null removes them. */
export interface McpServerInput {
	description?: string | null;
	url: string;
	/** Write-only: the values are encrypted with the master key and never returned. */
	headers?: McpServerHeader[] | null;
	identityHeaders?: { username?: string | null; session?: string | null };
	enabled?: boolean;
	listDirectly?: boolean;
	trustAnnotations?: boolean;
	timeoutSeconds?: number;
	grants?: McpServerGrant[];
}

export interface McpServerListResponse {
	servers: McpServerView[];
}

export interface McpServerResponse {
	server: McpServerView;
}

export interface McpServerToolsResponse {
	tools: McpToolView[];
	status: McpServerStatus;
}

/** A server as a session's settings and tool guide see it. */
export interface McpSessionServer {
	name: string;
	description: string | null;
	/** False when the owner turned it off in the session settings. */
	enabled: boolean;
	/** Whether its last tool list is available. */
	available: boolean;
	/** Whether a `readOnlyHint` on its tools may make them `mcp.read`. */
	trustAnnotations: boolean;
	/** Its tools also appear in the model's tool list as `mcp__<server>__<tool>`. */
	listDirectly: boolean;
	/** The per-call timeout the server's call uses. */
	timeoutMs: number;
}

/** The state of one external tool call (doc/design/extensions.md "External calls"). */
export type ExternalCallState =
	| "awaiting_approval"
	| "running"
	| "succeeded"
	| "failed"
	| "rejected"
	| "cancelled"
	| "unknown";

/**
 * One external call as the approvals page and the session decision panel show it. The row holds only the
 * state that must survive while the call is in progress, so a terminal call has empty `arguments`; its
 * result is in the transcript and who decided in the audit log.
 */
export interface ExternalCallView {
	id: string;
	server: string;
	tool: string;
	arguments: unknown;
	operation: Operation;
	annotations: McpToolAnnotations | null;
	state: ExternalCallState;
	approval: ApprovalRecord | null;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string;
	rootSessionId: string | null;
	handlerType: "agent" | "user" | null;
	handlerSessionId: string | null;
	createdAt: string;
	finishedAt: string | null;
}

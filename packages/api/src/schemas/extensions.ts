/**
 * Runtime schemas for the administrator's MCP servers (`../extensions.ts`,
 * doc/design/extensions.md "MCP servers"). Header values are write-only.
 */
import { z } from "zod";
import { ApprovalRecordSchema, OperationSchema } from "./policy.ts";

/** One request header; the value is never returned, only the name. */
export const McpServerHeaderSchema = z.object({ name: z.string(), value: z.string() }).meta({ id: "McpServerHeader" });

/** How a server's connection currently behaves (doc/design/extensions.md "Connections"). */
export const McpServerStateSchema = z.enum(["unknown", "connecting", "ready", "unavailable"]);

export const McpServerStatusSchema = z
	.object({
		state: McpServerStateSchema,
		lastError: z.string().nullable().describe("Why the last connection attempt failed; null when it succeeded."),
		nextAttemptAt: z.string().nullable().describe("When the next automatic attempt happens while unavailable."),
		toolCount: z.number().describe("Tools of the last successful listing; 0 before the first one."),
	})
	.meta({ id: "McpServerStatus" });

/** The tool annotations rules may use (doc/design/extensions.md "Rules and approvals"). */
export const McpToolAnnotationsSchema = z
	.object({
		title: z.string().optional(),
		readOnlyHint: z.boolean().optional(),
		destructiveHint: z.boolean().optional(),
		idempotentHint: z.boolean().optional(),
		openWorldHint: z.boolean().optional(),
	})
	.meta({ id: "McpToolAnnotations" });

/** One MCP tool as the server listed it. */
export const McpToolViewSchema = z
	.object({
		name: z.string(),
		title: z.string().nullable(),
		description: z.string().nullable(),
		inputSchema: z.unknown().describe("The tool's JSON input schema, passed to the model unchanged."),
		annotations: McpToolAnnotationsSchema.nullable(),
	})
	.meta({ id: "McpToolView" });

/** The two headers that carry the CRH identity to the server; they are not authentication. */
export const McpServerIdentityHeadersSchema = z
	.object({
		username: z.string().nullable(),
		session: z.string().nullable(),
	})
	.meta({ id: "McpServerIdentityHeaders" });

export const McpServerGrantSchema = z
	.object({
		granteeType: z.enum(["user", "user_group"]),
		granteeId: z.string(),
	})
	.meta({ id: "McpServerGrant" });

/** An MCP server as administrators see it: header names, never their values. */
export const McpServerViewSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string().nullable().describe("Shown to the model with the server; may be null."),
		url: z.string(),
		hasHeaders: z.boolean().describe("Whether headers are stored; their values are never returned."),
		headerNames: z.array(z.string()).describe("The stored header names, for display only."),
		identityHeaders: McpServerIdentityHeadersSchema,
		enabled: z.boolean(),
		listDirectly: z.boolean().describe("Whether its tools appear directly in the model's tool list."),
		trustAnnotations: z.boolean().describe("Whether a tool's readOnlyHint may make it `mcp.read`."),
		timeoutSeconds: z.number().describe("Per call; a longer one also protects a slow server."),
		grants: z.array(McpServerGrantSchema),
		status: McpServerStatusSchema,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "McpServerView" });

/** The identity headers a caller may select for a server. */
export const McpServerIdentityHeaderSelectionSchema = z
	.object({
		username: z.string().nullable().optional(),
		session: z.string().nullable().optional(),
	})
	.loose();

/** `PUT /api/mcp-servers/{name}`; omitted fields keep their value, null where allowed removes them. */
export const McpServerInputSchema = z.object({
	description: z.string().nullable().optional(),
	url: z.string(),
	headers: z.array(McpServerHeaderSchema).nullable().optional().describe("Write-only; encrypted with the master key."),
	identityHeaders: McpServerIdentityHeaderSelectionSchema.optional(),
	enabled: z.boolean().optional(),
	listDirectly: z.boolean().optional(),
	trustAnnotations: z.boolean().optional(),
	timeoutSeconds: z.number().optional(),
	grants: z.array(McpServerGrantSchema).optional(),
});

export const McpServerListResponseSchema = z.object({ servers: z.array(McpServerViewSchema) });

export const McpServerResponseSchema = z.object({ server: McpServerViewSchema });

export const McpServerToolsResponseSchema = z
	.object({
		tools: z.array(McpToolViewSchema),
		status: McpServerStatusSchema,
	})
	.meta({ id: "McpServerToolsResponse" });

/** `GET /api/mcp-servers/{name}/tools` when the server could not be reached. */
export const McpServerToolsErrorSchema = z
	.object({
		error: z.string(),
		status: McpServerStatusSchema,
	})
	.meta({ id: "McpServerToolsError" });

export const McpServerStatusResponseSchema = z.object({ status: McpServerStatusSchema });

/** Path parameter of the MCP server routes; the name is the server's stable identity. */
export const McpServerNameParamSchema = z.object({ name: z.string() });

/** An MCP server as one session's settings and tool guide see it. */
export const McpSessionServerSchema = z
	.object({
		name: z.string(),
		description: z.string().nullable(),
		enabled: z.boolean().describe("False when the owner turned it off in the session settings."),
		available: z.boolean().describe("Whether its last tool list is available."),
		trustAnnotations: z.boolean().describe("Whether a `readOnlyHint` on its tools may make them `mcp.read`."),
		listDirectly: z.boolean().describe("Its tools also appear in the model's tool list as `mcp__<server>__<tool>`."),
		timeoutMs: z.number().describe("The per-call timeout the server's call uses."),
	})
	.meta({ id: "McpSessionServer" });

/** The state of one external tool call (doc/design/extensions.md "External calls"). */
export const ExternalCallStateSchema = z.enum([
	"awaiting_approval",
	"running",
	"succeeded",
	"failed",
	"rejected",
	"cancelled",
	"unknown",
]);

/**
 * One external call as the approvals page and the session decision panel show it. A terminal call has
 * empty `arguments`; its result is in the transcript and who decided in the audit log.
 */
export const ExternalCallViewSchema = z
	.object({
		id: z.string(),
		server: z.string(),
		tool: z.string(),
		arguments: z.unknown(),
		operation: OperationSchema,
		annotations: McpToolAnnotationsSchema.nullable(),
		state: ExternalCallStateSchema,
		approval: ApprovalRecordSchema.nullable(),
		actorType: z.string(),
		actorId: z.string(),
		onBehalfOfUserId: z.string(),
		rootSessionId: z.string().nullable(),
		handlerType: z.enum(["agent", "user"]).nullable(),
		handlerSessionId: z.string().nullable(),
		createdAt: z.string(),
		finishedAt: z.string().nullable(),
	})
	.meta({ id: "ExternalCallView" });

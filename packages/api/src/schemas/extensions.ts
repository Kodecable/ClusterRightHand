/**
 * Runtime schemas for the administrator's extensions (`../extensions.ts`,
 * doc/design/extensions.md). An extension is either an MCP server an administrator connects or one of
 * crhs's built-in extensions; header values are write-only.
 */
import { z } from "zod";
import { ApprovalPhaseSchema, ApprovalRecordSchema, OperationSchema } from "./policy.ts";

/** What an extension is: a connected MCP server or one that ships with crhs. */
export const ExtensionKindSchema = z.enum(["mcp", "builtin"]);

/** Who may use an extension: every user, or only the granted users and user groups. */
export const ExtensionAvailabilitySchema = z.enum(["everyone", "granted"]);

/** One request header; the value is never returned, only the name. */
export const ExtensionHeaderSchema = z.object({ name: z.string(), value: z.string() }).meta({ id: "ExtensionHeader" });

/** How an extension's connection currently behaves (doc/design/extensions.md "MCP connections"). */
export const ExtensionStateSchema = z.enum(["unknown", "connecting", "ready", "unavailable"]);

export const ExtensionStatusSchema = z
	.object({
		state: ExtensionStateSchema,
		lastError: z.string().nullable().describe("Why the last connection attempt failed; null when it succeeded."),
		nextAttemptAt: z.string().nullable().describe("When the next automatic attempt happens while unavailable."),
		toolCount: z.number().describe("Tools of the last successful listing; 0 before the first one."),
	})
	.meta({ id: "ExtensionStatus" });

/** The tool annotations rules may use (doc/design/extensions.md "Rules and approvals"). */
export const ExtensionToolAnnotationsSchema = z
	.object({
		title: z.string().optional(),
		readOnlyHint: z.boolean().optional(),
		destructiveHint: z.boolean().optional(),
		idempotentHint: z.boolean().optional(),
		openWorldHint: z.boolean().optional(),
	})
	.meta({ id: "ExtensionToolAnnotations" });

/** One tool as the extension lists it. */
export const ExtensionToolViewSchema = z
	.object({
		name: z.string(),
		title: z.string().nullable(),
		description: z.string().nullable(),
		inputSchema: z.unknown().describe("The tool's JSON input schema, passed to the model unchanged."),
		annotations: ExtensionToolAnnotationsSchema.nullable(),
	})
	.meta({ id: "ExtensionToolView" });

/** The two headers that carry the CRH identity to an MCP server; they are not authentication. */
export const ExtensionIdentityHeadersSchema = z
	.object({
		username: z.string().nullable(),
		session: z.string().nullable(),
	})
	.meta({ id: "ExtensionIdentityHeaders" });

export const ExtensionGrantSchema = z
	.object({
		granteeType: z.enum(["user", "user_group"]),
		granteeId: z.string(),
	})
	.meta({ id: "ExtensionGrant" });

/** An extension as administrators see it: header names, never their values. */
export const ExtensionViewSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		kind: ExtensionKindSchema,
		description: z.string().nullable().describe("Shown to the model with the extension; may be null."),
		url: z.string().nullable().describe("The Streamable HTTP endpoint; null for a built-in extension."),
		hasHeaders: z.boolean().describe("Whether headers are stored; their values are never returned."),
		headerNames: z.array(z.string()).describe("The stored header names, for display only."),
		identityHeaders: ExtensionIdentityHeadersSchema,
		enabled: z.boolean(),
		listDirectly: z.boolean().describe("Whether its tools appear directly in the model's tool list."),
		availability: ExtensionAvailabilitySchema.describe("Every user, or only the granted users and user groups."),
		trustAnnotations: z
			.boolean()
			.nullable()
			.describe("Whether a tool's readOnlyHint may make it `ext.read`; null for a built-in."),
		timeoutSeconds: z
			.number()
			.nullable()
			.describe("Per call; a longer one also protects a slow server; null for a built-in."),
		grants: z.array(ExtensionGrantSchema),
		status: ExtensionStatusSchema,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.meta({ id: "ExtensionView" });

/** The identity headers a caller may select for an MCP extension. */
export const ExtensionIdentityHeaderSelectionSchema = z
	.object({
		username: z.string().nullable().optional(),
		session: z.string().nullable().optional(),
	})
	.loose();

/** `PUT /api/extensions/{name}`; omitted fields keep their value, null where allowed removes them. */
export const ExtensionInputSchema = z.object({
	description: z.string().nullable().optional(),
	url: z.string().optional().describe("The Streamable HTTP endpoint; required to create an MCP extension."),
	headers: z.array(ExtensionHeaderSchema).nullable().optional().describe("Write-only; encrypted with the master key."),
	identityHeaders: ExtensionIdentityHeaderSelectionSchema.optional(),
	enabled: z.boolean().optional(),
	listDirectly: z.boolean().optional(),
	availability: ExtensionAvailabilitySchema.optional(),
	trustAnnotations: z.boolean().optional(),
	timeoutSeconds: z.number().optional(),
	grants: z.array(ExtensionGrantSchema).optional(),
});

export const ExtensionListResponseSchema = z.object({ extensions: z.array(ExtensionViewSchema) });

export const ExtensionResponseSchema = z.object({ extension: ExtensionViewSchema });

export const ExtensionToolsResponseSchema = z
	.object({
		tools: z.array(ExtensionToolViewSchema),
		status: ExtensionStatusSchema,
	})
	.meta({ id: "ExtensionToolsResponse" });

/** `GET /api/extensions/{name}/tools` when the extension could not be reached. */
export const ExtensionToolsErrorSchema = z
	.object({
		error: z.string(),
		status: ExtensionStatusSchema,
	})
	.meta({ id: "ExtensionToolsError" });

export const ExtensionStatusResponseSchema = z.object({ status: ExtensionStatusSchema });

/** Path parameter of the extension routes; the name is the extension's stable identity. */
export const ExtensionNameParamSchema = z.object({ name: z.string() });

/** An extension as one session's settings and tool guide see it. */
export const SessionExtensionSchema = z
	.object({
		name: z.string(),
		kind: ExtensionKindSchema,
		description: z.string().nullable(),
		enabled: z.boolean().describe("False when the owner turned it off in the session settings."),
		available: z.boolean().describe("Whether its tools are available; a built-in extension is always ready."),
		listDirectly: z.boolean().describe("Its tools also appear in the model's tool list as `ext__<extension>__<tool>`."),
	})
	.meta({ id: "SessionExtension" });

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
		extension: z.string(),
		tool: z.string(),
		arguments: z.unknown(),
		operation: OperationSchema,
		annotations: ExtensionToolAnnotationsSchema.nullable(),
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
		phase: ApprovalPhaseSchema.describe("`reviewing` while Auto Review decides; otherwise `awaiting_user`."),
	})
	.meta({ id: "ExternalCallView" });

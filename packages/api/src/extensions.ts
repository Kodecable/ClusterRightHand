/**
 * Tools beyond the cluster tools, called "extensions" (doc/design/extensions.md). An extension is either an
 * MCP server an administrator connected or one of crhs's built-in extensions (`docs`, `api`). Agent
 * sessions reach their tools through `search_tools` and `call_tool`, and every call goes through the same
 * rules, approvals and audit log as a cluster task.
 */

import type { z } from "zod";
import type {
	ExtensionAvailabilitySchema,
	ExtensionGrantSchema,
	ExtensionHeaderSchema,
	ExtensionIdentityHeadersSchema,
	ExtensionInputSchema,
	ExtensionKindSchema,
	ExtensionListResponseSchema,
	ExtensionResponseSchema,
	ExtensionStateSchema,
	ExtensionStatusSchema,
	ExtensionToolAnnotationsSchema,
	ExtensionToolsResponseSchema,
	ExtensionToolViewSchema,
	ExtensionViewSchema,
	ExternalCallStateSchema,
	ExternalCallViewSchema,
	SessionExtensionSchema,
} from "./schemas/extensions.ts";

/** What kind of extension this is: an MCP server or a built-in of crhs. */
export type ExtensionKind = z.infer<typeof ExtensionKindSchema>;

/** Who may use an extension: every user, or only the granted users and user groups. */
export type ExtensionAvailability = z.infer<typeof ExtensionAvailabilitySchema>;

/** One request header of an MCP extension; the value is write-only. */
export type ExtensionHeader = z.infer<typeof ExtensionHeaderSchema>;

/**
 * The two headers that carry the CRH identity to an MCP server: the user's name and the session id. They
 * are written by crhs on every call and are not authentication.
 */
export type ExtensionIdentityHeaders = z.infer<typeof ExtensionIdentityHeadersSchema>;

/** How an extension's connection currently behaves (doc/design/extensions.md "MCP connections"). */
export type ExtensionState = z.infer<typeof ExtensionStateSchema>;

export type ExtensionStatus = z.infer<typeof ExtensionStatusSchema>;

/** One tool as the extension listed it. */
export type ExtensionToolView = z.infer<typeof ExtensionToolViewSchema>;

/** The tool annotations rules may use (doc/design/extensions.md "Rules and approvals"). */
export type ExtensionToolAnnotations = z.infer<typeof ExtensionToolAnnotationsSchema>;

export type ExtensionGrant = z.infer<typeof ExtensionGrantSchema>;

export type ExtensionView = z.infer<typeof ExtensionViewSchema>;

/** `PUT /api/extensions/:name`; omitted fields keep their value, `headers` null removes them. */
export type ExtensionInput = z.infer<typeof ExtensionInputSchema>;

export type ExtensionListResponse = z.infer<typeof ExtensionListResponseSchema>;

export type ExtensionResponse = z.infer<typeof ExtensionResponseSchema>;

export type ExtensionToolsResponse = z.infer<typeof ExtensionToolsResponseSchema>;

/** An extension as a session's settings and tool guide see it. */
export type SessionExtension = z.infer<typeof SessionExtensionSchema>;

/** The state of one external tool call (doc/design/extensions.md "External calls"). */
export type ExternalCallState = z.infer<typeof ExternalCallStateSchema>;

/**
 * One external call as the approvals page and the session decision panel show it. The row holds only the
 * state that must survive while the call is in progress, so a terminal call has empty `arguments`; its
 * result is in the transcript and who decided in the audit log.
 */
export type ExternalCallView = z.infer<typeof ExternalCallViewSchema>;

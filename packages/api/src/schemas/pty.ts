/**
 * Runtime schemas for the terminal subsystem (doc/design/pty.md): the terminal view, the create and
 * resize bodies, the in-memory rule approvals and the signature wait.
 *
 * A terminal is memory-only: crhs keeps a copy of what crha holds, rebuilt from the node's `pty.list`
 * after a crhs restart. The id is a UUIDv7 chosen by crhs at open.
 */
import { z } from "zod";
import { ApprovalAlwaysAllowSchema, ApprovalRequestSchema } from "./approval-request.ts";
import { PendingAuthorizationSchema, TaskAuthorizationRejectionSchema } from "./authorizations.ts";
import { ErrorResponseSchema } from "./common.ts";

/** The maximum accepted rows or columns, as crha validates them. */
export const PTY_MAX_SIZE = 1000;

export const PtySizeSchema = z
	.object({
		rows: z.number().int().min(1).max(PTY_MAX_SIZE),
		cols: z.number().int().min(1).max(PTY_MAX_SIZE),
	})
	.meta({ id: "PtySize" });

/**
 * A terminal's state. `opening` covers the wait for a rule approval or an authorization before
 * `pty.open` is sent; `running` and `exited` are the object's own states.
 */
export const PtyStateSchema = z.enum(["opening", "running", "exited"]).meta({
	id: "PtyState",
	description: "opening while an approval or authorization is pending, then running or exited.",
});

/** One WebUI viewer attached to a terminal. */
export const PtyViewerSchema = z
	.object({
		id: z.string().describe("The attach connection's id, stable for its lifetime."),
		userId: z.string(),
		username: z.string().nullable(),
		clientAddress: z.string().nullable().describe("The client address crhs saw, when it knew one."),
		attachedAt: z.string(),
	})
	.meta({ id: "PtyViewer" });

/**
 * A rule approval waiting for the user (doc/design/pty.md "Rules"): an agent's open, write or resize
 * that the session's rules judged `require-approval`. It lives in memory with the terminal.
 */
export const PtyApprovalSchema = z
	.object({
		id: z.string(),
		method: z.enum(["pty.create", "pty.io"]).describe("The rule method the request was judged under."),
		privileged: z.boolean(),
		argv: z.array(z.string()).describe("For pty.create: the command the terminal would run."),
		input: z.string().nullable().describe("For pty.io: the text the agent would type, clipped."),
		keys: z.array(z.string()).describe("For pty.io: the named keys the agent would send."),
		screen: z.string().describe("The terminal's screen when the request was made, clipped."),
		createdAt: z.string(),
		attempt: z.number().optional().describe("For pty.create: the pty.open attempt the request belongs to."),
		alwaysAllow: z.array(ApprovalAlwaysAllowSchema).describe("The server-built always-allow candidates."),
	})
	.meta({ id: "PtyApproval" });

/** One terminal as crhs holds it. */
export const PtyViewSchema = z
	.object({
		id: z.string(),
		nodeId: z.string(),
		nodeName: z.string().nullable().describe("The node's name, when it could be read."),
		userId: z.string().describe("The person the terminal belongs to."),
		username: z.string().nullable(),
		privileged: z.boolean(),
		argv: z.array(z.string()).describe("The command; empty means the identity's login shell."),
		size: PtySizeSchema,
		title: z
			.string()
			.describe(
				"The title the program set through OSC 0/2, sanitized (control characters removed, whitespace folded, at most 256 characters). Untrusted text: it never replaces the node name.",
			),
		state: PtyStateSchema,
		exitCode: z.number().nullable().describe("The exit code once exited; null while it runs."),
		creatingSessionId: z.string().nullable().describe("The session whose agent opened it; null for a person."),
		sessionIds: z.array(z.string()).describe("The sessions associated with it, in association order."),
		idleTimeoutMs: z.number().nullable().describe("The idle timeout; null for a person-opened terminal."),
		openedAt: z.string(),
		endedAt: z.string().nullable(),
		lastActivityAt: z.string(),
		viewers: z.array(PtyViewerSchema),
		authorization: PendingAuthorizationSchema.nullable().describe(
			"The signature wait of a privileged terminal, when one waits; null otherwise.",
		),
		authorizationPhase: z
			.enum(["preparing", "waiting", "ended"])
			.nullable()
			.describe("The signature wait's phase; null when no authorization is involved."),
		rejection: TaskAuthorizationRejectionSchema.nullable(),
		approval: PtyApprovalSchema.nullable().describe("The rule approval waiting for the user, if any."),
		approvalRequest: ApprovalRequestSchema.nullable().describe(
			'The same approval as one compact request, for the shared decision panel (doc/design/access-control.md "Approvals").',
		),
	})
	.meta({ id: "PtyView" });

/**
 * One terminal approval as the approvals API lists it: the terminal it belongs to and the same compact
 * request every other waiting item carries (doc/design/access-control.md "Approvals").
 */
export const PtyApprovalItemSchema = z
	.object({
		terminalId: z.string(),
		nodeId: z.string(),
		nodeName: z.string().nullable(),
		userId: z.string(),
		username: z.string().nullable(),
		createdAt: z.string(),
		request: ApprovalRequestSchema,
	})
	.meta({ id: "PtyApprovalItem" });

/** `GET /api/ptys`: whether the subsystem is on and the terminals the caller may see. */
export const PtyListResponseSchema = z
	.object({
		enabled: z.boolean().describe("False hides the Terminals page and the agent tools."),
		terminals: z.array(PtyViewSchema),
	})
	.meta({ id: "PtyListResponse" });

export const PtyResponseSchema = z
	.object({ terminal: PtyViewSchema.meta({ id: "PtyTerminal" }) })
	.meta({ id: "PtyResponse" });

/** `POST /api/ptys`: a person opens a terminal on a node they reach. */
export const PtyCreateBodySchema = z
	.object({
		node: z.string().describe("A node id or name the caller has access to."),
		argv: z
			.array(z.string().min(1))
			.max(64)
			.optional()
			.describe("The command; omitted runs the identity's login shell."),
		privileged: z.boolean().optional().describe("Open it in the privileged mode, after its authorization."),
		size: PtySizeSchema.optional(),
	})
	.meta({ id: "PtyCreateBody" });

/** `POST /api/ptys/{id}/resize`: a terminal's one size changes only here or through an agent. */
export const PtyResizeBodySchema = PtySizeSchema.meta({ id: "PtyResizeBody" });

/**
 * `POST /api/ptys/{id}/approval`: the user's answer to a rule approval, through the same body every other
 * approval decision takes (`ApprovalBodySchema`). The route is described by `PtyView` and `PtyApprovalItem`.
 */

/** `GET /api/ptys/{id}/authorization`: the phase of the signature wait and its planned options. */
export const PtyAuthorizationResponseSchema = z
	.object({
		phase: z.enum(["preparing", "waiting", "ended"]),
		authorization: PendingAuthorizationSchema.nullable(),
	})
	.meta({ id: "PtyAuthorizationResponse" });

/** `GET /api/ptys/enabled`: whether the Terminals page and the agent tools exist. */
export const PtyEnabledSchema = z.object({ enabled: z.boolean() }).meta({ id: "PtyEnabled" });

/** `POST /api/ptys/{id}/authorization/reject`: the owner declines to sign. */
export const PtyRejectAuthorizationBodySchema = z
	.object({ reason: z.string().max(2000).optional().describe("Why the owner declined to sign.") })
	.meta({ id: "PtyRejectAuthorizationBody" });

/** The envelope of the terminal routes' expected failures. */
export const PtyErrorResponseSchema = ErrorResponseSchema;

/** The fields a terminal's owner or an administrator may change through the API. */
export type PtyApprovalItem = z.infer<typeof PtyApprovalItemSchema>;
export type PtyCreateBody = z.infer<typeof PtyCreateBodySchema>;
export type PtyResizeBody = z.infer<typeof PtyResizeBodySchema>;
export type PtyAuthorizationResponse = z.infer<typeof PtyAuthorizationResponseSchema>;
export type PtyEnabled = z.infer<typeof PtyEnabledSchema>;
export type PtyRejectAuthorizationBody = z.infer<typeof PtyRejectAuthorizationBodySchema>;

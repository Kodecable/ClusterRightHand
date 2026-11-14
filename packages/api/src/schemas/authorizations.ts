/**
 * Runtime schemas for privileged-task authorizations (`../authorizations.ts`,
 * doc/design/privilege.md "Authorization path"): plans, the payload to sign, pending views,
 * the administrator's list and the owner's rejection.
 */
import { z } from "zod";
import { RuleMethodSchema } from "./policy.ts";
import { TaskStateSchema } from "./task-state.ts";

/** The three ways a node can accept a privileged task. */
export const AuthorizationPathSchema = z.enum(["crhs", "user", "local"]);

/** One entry of a planned path. */
export const PlannedPathEntrySchema = z
	.object({
		name: z.string(),
		role: z.enum(["crhs", "user", "local"]),
		credential: z.enum(["sshsig", "webauthn"]).optional(),
		cosign: z.enum(["required", "available", "missing"]).optional(),
	})
	.meta({ id: "PlannedPathEntry" });

/** One path of a task's authorization plan (doc/design/privilege.md "Authorization path"). */
export const PlannedPathViewSchema = z
	.object({
		path: AuthorizationPathSchema,
		entries: z.array(PlannedPathEntrySchema),
		ttlMs: z
			.number()
			.optional()
			.describe("user path only: how long the payload is valid, capped by the strictest accepting entry."),
	})
	.meta({ id: "PlannedPathView" });

export const TaskAuthorizationPlanViewSchema = z
	.object({
		paths: z.array(PlannedPathViewSchema),
		reason: z.string().optional().describe("Why there is no usable path; set exactly when `paths` is empty."),
	})
	.meta({ id: "TaskAuthorizationPlanView" });

/** The payload the owner has to sign, as stored on the task record. */
export const PendingPayloadViewSchema = z
	.object({
		payload: z.string().describe("Base64 of the exact CBOR payload bytes."),
		id: z.string().describe("Hex SHA-256 of the payload bytes: the authorization id a submission carries."),
		deadline: z.string().nullable().describe("ISO 8601; never null for a planned user path."),
		taskIds: z.array(z.string()).describe("The task ids the payload covers."),
		attempt: z.number().describe("The attempt every covered task uses (a task group shares the highest one)."),
	})
	.meta({ id: "PendingPayloadView" });

export const TaskAuthorizationRejectionSchema = z
	.object({
		code: z.string(),
		message: z.string(),
		attempt: z.number().describe("The attempt crha rejected."),
		at: z.string(),
	})
	.meta({ id: "TaskAuthorizationRejection" });

/** The authorization state of a privileged task (doc/design/privilege.md "Server-side authorization"). */
export const TaskAuthorizationViewSchema = z
	.object({
		plan: TaskAuthorizationPlanViewSchema,
		tried: z.array(AuthorizationPathSchema).describe("Paths a crha rejection already ruled out for this task."),
		dispatchedPath: AuthorizationPathSchema.nullable().describe(
			"The path the last `task.start` used; null when nothing was sent yet.",
		),
		payloadId: z.string().nullable().describe("The `authorizations.id` of the last signature sent."),
		attempt: z.number().describe("The attempt of the last `task.start`."),
		trustDigest: z.string().nullable().describe("Hex digest of the TrustSummary the plan was computed from."),
		pending: PendingPayloadViewSchema.nullable().describe(
			"Always null in a task view: the payload has its own endpoint.",
		),
		local: z.object({ attempt: z.number() }).nullable().describe("The attempt a `local.request` was sent for."),
		lastRejection: TaskAuthorizationRejectionSchema.nullable(),
		updatedAt: z.string(),
	})
	.meta({ id: "TaskAuthorizationView" });

/** The decoded form of a pending authorization payload. */
export const DecodedAuthorizationPayloadSchema = z
	.object({
		nodes: z.array(z.string()),
		command: z
			.union([
				z.object({
					method: RuleMethodSchema,
					match: z.literal("exact"),
					target: z.string(),
					specSha256: z.string(),
				}),
				z.object({ method: RuleMethodSchema, match: z.literal("prefix"), target: z.string() }),
			])
			.nullable(),
		issuedAt: z.string(),
		deadline: z.string().nullable(),
		taskIds: z.array(z.string()).nullable(),
		attempt: z.number().nullable(),
		note: z.string(),
	})
	.meta({ id: "DecodedAuthorizationPayload" });

/** One of the owner's Passkeys the node trusts for the payload. */
export const PendingPasskeySchema = z
	.object({
		credentialId: z.string(),
		name: z.string(),
		rpId: z.string(),
		origins: z.array(z.string()),
		requireUv: z.boolean(),
		entry: z.string().describe("The trust entry that would accept it."),
	})
	.meta({ id: "PendingPasskey" });

/** The payload a waiting task's owner has to sign. */
export const PendingAuthorizationSchema = z
	.object({
		id: z.string(),
		payload: z.string(),
		decoded: DecodedAuthorizationPayloadSchema,
		challenge: z.string(),
		deadline: z.string().nullable(),
		taskIds: z.array(z.string()),
		attempt: z.number(),
		passkeys: z.array(PendingPasskeySchema),
		localRequested: z.boolean(),
		lastRejection: TaskAuthorizationRejectionSchema.nullable(),
		tried: z.array(AuthorizationPathSchema),
	})
	.meta({ id: "PendingAuthorization" });

export const TaskGroupPendingTaskSchema = z
	.object({
		id: z.string(),
		nodeId: z.string(),
		nodeName: z.string(),
		attempt: z.number(),
		state: TaskStateSchema,
		localRequested: z.boolean(),
		lastRejection: TaskAuthorizationRejectionSchema.nullable(),
		tried: z.array(AuthorizationPathSchema),
	})
	.meta({ id: "TaskGroupPendingTask" });

/** A task group's waiting tasks around the payload they share. */
export const TaskGroupPendingSchema = z
	.object({
		authorization: PendingAuthorizationSchema,
		tasks: z.array(TaskGroupPendingTaskSchema),
	})
	.meta({ id: "TaskGroupPending" });

/** Body of `POST /tasks/{id}/authorization/reject` and `POST /task-groups/{id}/authorization/reject`. */
export const RejectAuthorizationBodySchema = z.object({
	reason: z.string().optional().describe("Why the owner declined to sign; stored as the task's error message."),
});

/** `POST /api/authorizations`: a pasted signed authorization or a Passkey assertion for a payload. */
export const SubmitAuthorizationBodySchema = z.object({
	authorization: z.string().optional().describe("Base64 of a CBOR Authorization, e.g. the output of `crha grant`."),
	payloadId: z.string().optional().describe("The pending payload's id, with `webauthn`."),
	webauthn: z.unknown().optional().describe("The AuthenticationResponseJSON of the waiting page's Passkey button."),
});

/** One stored authorization (doc/design/privilege.md "Authorizations"). */
export const AuthorizationSummarySchema = z
	.object({
		id: z.string(),
		issuerUserId: z.string().nullable(),
		issuerUsername: z.string().nullable(),
		nodes: z.array(z.string()),
		command: DecodedAuthorizationPayloadSchema.shape.command,
		taskIds: z.array(z.string()).nullable(),
		attempt: z.number().nullable(),
		note: z.string(),
		issuedAt: z.string().nullable(),
		deadline: z.string().nullable(),
		createdAt: z.string(),
	})
	.meta({ id: "AuthorizationSummary" });

export const AuthorizationListResponseSchema = z
	.object({
		items: z.array(AuthorizationSummarySchema),
		nextCursor: z.string().nullable().describe("Pass as `cursor` for the next page; null on the last one."),
	})
	.meta({ id: "AuthorizationListResponse" });

export const AuthorizationSubmittedResponseSchema = z
	.object({ authorization: z.object({ id: z.string() }) })
	.meta({ id: "AuthorizationSubmittedResponse" });

export const TaskAuthorizationResponseSchema = z.object({
	authorization: PendingAuthorizationSchema.nullable().describe("Null when nothing is waiting any more."),
});

export const TaskGroupAuthorizationResponseSchema = z.object({
	taskGroup: TaskGroupPendingSchema.nullable().describe("Null when nothing is waiting any more."),
});

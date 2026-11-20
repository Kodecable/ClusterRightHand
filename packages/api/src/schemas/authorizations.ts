/**
 * Runtime schemas for privileged-task authorizations (`../authorizations.ts`,
 * doc/design/privilege.md "Authorization path"): the options a waiting task offers its owner, the
 * payload a `sign` option carries, pending views, the administrator's list and the owner's rejection.
 */
import { z } from "zod";
import { RuleMethodSchema } from "./policy.ts";
import { TaskStateSchema } from "./task-state.ts";

/** The paths a crha rejection can rule out (doc/design/privilege.md "Authorization path"). */
export const AuthorizationPathSchema = z.enum(["crhs", "user"]);

/** One trust entry that can sign a `sign` option. */
export const PlannedPathEntrySchema = z
	.object({
		name: z.string(),
		role: z.enum(["crhs", "user"]),
		credential: z.enum(["sshsig", "webauthn"]).optional(),
		cosign: z.enum(["required", "available", "missing"]).optional(),
	})
	.meta({ id: "PlannedPathEntry" });

/** The exact payload a `sign` option asks the owner to sign, and the complete spec it binds. */
export const PendingPayloadViewSchema = z
	.object({
		payload: z.string().describe("Base64 of the exact CBOR payload bytes."),
		spec: z
			.string()
			.describe(
				"Base64 of the canonical CBOR TaskSpec the payload binds, so `crhu sign --spec` can check the hash; served only to the owner, with the payload.",
			),
		id: z.string().describe("Hex SHA-256 of the payload bytes: the authorization id a submission carries."),
		deadline: z.string().nullable().describe("ISO 8601; never null for a planned sign option."),
		taskIds: z.array(z.string()).describe("The task ids the payload covers."),
		attempt: z.number().describe("The attempt every covered task uses (a task group shares the highest one)."),
	})
	.meta({ id: "PendingPayloadView" });

/** The decoded form of a pending authorization payload. */
export const DecodedAuthorizationPayloadSchema = z
	.object({
		nodes: z.array(z.string()),
		command: z
			.union([
				z.object({ match: z.literal("spec"), specSha256: z.string() }),
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

/** The payload of a `sign` option as the owner's waiting page renders it. */
export const PendingSignPayloadSchema = PendingPayloadViewSchema.extend({
	decoded: DecodedAuthorizationPayloadSchema,
	challenge: z.string().describe("Base64url of the WebAuthn challenge derived from the payload."),
	passkeys: z.array(PendingPasskeySchema),
}).meta({ id: "PendingSignPayload" });

/** One way the owner can authorize: a signature over a stored payload. */
export const SignAuthorizationOptionSchema = z
	.object({
		kind: z.literal("sign"),
		entries: z.array(PlannedPathEntrySchema),
		fingerprints: z
			.array(z.string())
			.optional()
			.describe("SHA256 fingerprints of the owner's SSH credentials that match the entries; a signing hint."),
		ttlMs: z.number().describe("How long the payload is valid, capped by the strictest accepting entry."),
		payload: PendingPayloadViewSchema.nullable().describe(
			"The exact bytes to sign; null in a task view, served only by the owner's endpoint.",
		),
	})
	.meta({ id: "SignAuthorizationOption" });

/** One way the owner can authorize: opening a local approval window on one node. */
export const LocalWindowAuthorizationOptionSchema = z
	.object({
		kind: z.literal("local_window"),
		nodeId: z.string(),
		nodeName: z.string(),
	})
	.meta({ id: "LocalWindowAuthorizationOption" });

/** Not a choice: the owner already signed, and the task is sent when its absent node is back. */
export const AwaitingNodeAuthorizationOptionSchema = z
	.object({ kind: z.literal("awaiting_node") })
	.meta({ id: "AwaitingNodeAuthorizationOption" });

/** One option a waiting task or task group offers its owner. */
export const AuthorizationOptionSchema = z
	.discriminatedUnion("kind", [
		SignAuthorizationOptionSchema,
		LocalWindowAuthorizationOptionSchema,
		AwaitingNodeAuthorizationOptionSchema,
	])
	.meta({ id: "AuthorizationOption" });

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
		options: z
			.array(AuthorizationOptionSchema)
			.describe("The ways the owner can authorize; empty until the first plan is written."),
		crhsRejected: z
			.object({
				window: z
					.number()
					.nullable()
					.describe("The node's local window identity (`openedAtMs`) when crha rejected; null when none was open."),
			})
			.nullable()
			.describe("Set when crha rejected crhs's own signature: that path stays ruled out under the same window."),
		rejectedBefore: z
			.string()
			.nullable()
			.describe("Owner authorizations stored at or before this time are not used again for this task."),
		dispatchedPath: AuthorizationPathSchema.nullable().describe(
			"The path the last `task.start` used; null when nothing was sent yet.",
		),
		payloadId: z.string().nullable().describe("The `authorizations.id` of the last signature sent."),
		attempt: z.number().describe("The attempt of the last `task.start`."),
		trustDigest: z.string().nullable().describe("Hex digest of the TrustSummary the plan was computed from."),
		lastRejection: TaskAuthorizationRejectionSchema.nullable(),
		updatedAt: z.string(),
	})
	.meta({ id: "TaskAuthorizationView" });

/** The methods an authorization's prefix limit can name: the task methods, never an API or extension one. */
export const AuthorizationMethodSchema = z
	.enum(["exec", "file.read", "file.write"])
	.meta({ id: "AuthorizationMethod" });

/** The nodes and method a short reusable authorization for one waiting request covers. */
export const ReusableScopeSchema = z
	.object({
		nodes: z.array(z.string()).describe("The node UUIDs of the request's waiting tasks."),
		method: AuthorizationMethodSchema.describe(
			"The method every waiting task uses (file.write also covers file.read).",
		),
	})
	.meta({ id: "ReusableScope" });

/** A `sign` option as the owner's waiting page renders it: the stored payload plus how to sign it. */
export const PendingSignOptionSchema = z
	.object({
		kind: z.literal("sign"),
		entries: z.array(PlannedPathEntrySchema),
		fingerprints: z
			.array(z.string())
			.optional()
			.describe("SHA256 fingerprints of the owner's SSH credentials that match the entries; a signing hint."),
		ttlMs: z.number(),
		payload: PendingSignPayloadSchema,
		reusableScope: ReusableScopeSchema.nullable().describe(
			"What a short reusable authorization (an empty prefix for a few minutes) would cover; null when the waiting tasks use methods no single prefix limit covers.",
		),
	})
	.meta({ id: "PendingSignOption" });

/** One option the owner's waiting page renders. */
export const PendingAuthorizationOptionSchema = z
	.discriminatedUnion("kind", [
		PendingSignOptionSchema,
		LocalWindowAuthorizationOptionSchema,
		AwaitingNodeAuthorizationOptionSchema,
	])
	.meta({ id: "PendingAuthorizationOption" });

/** The options a waiting task's or task group's owner can take. */
export const PendingAuthorizationSchema = z
	.object({
		options: z.array(PendingAuthorizationOptionSchema),
		lastRejection: TaskAuthorizationRejectionSchema.nullable(),
	})
	.meta({ id: "PendingAuthorization" });

export const TaskGroupPendingTaskSchema = z
	.object({
		id: z.string(),
		nodeId: z.string(),
		nodeName: z.string(),
		attempt: z.number(),
		state: TaskStateSchema,
		lastRejection: TaskAuthorizationRejectionSchema.nullable(),
	})
	.meta({ id: "TaskGroupPendingTask" });

/** A task group's waiting tasks around the options they share. */
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
	authorization: z.string().optional().describe("Base64 of a CBOR Authorization, e.g. the output of `crhu sign`."),
	payload: z.string().optional().describe("Base64 of the exact payload bytes the Passkey signed, with `webauthn`."),
	webauthn: z.unknown().optional().describe("The AuthenticationResponseJSON of the waiting page's Passkey button."),
});

/** Longest lifetime a drafted authorization may ask for: one year. */
export const MAX_DRAFT_TTL_SECONDS = 366 * 24 * 60 * 60;

/** `POST /api/authorizations/draft`: the reusable authorization to build for the user to sign. */
export const AuthorizationDraftBodySchema = z.object({
	nodes: z
		.array(z.string())
		.min(1)
		.max(100)
		.describe("Node or node group UUIDs the authorization is for; the user must reach each node."),
	command: z
		.object({ method: AuthorizationMethodSchema, prefix: z.string().max(4096) })
		.nullable()
		.describe(
			"A method and target prefix (an empty prefix allows every target of the method); null allows any command.",
		),
	ttlSeconds: z.number().int().min(60).max(MAX_DRAFT_TTL_SECONDS).describe("How long it stays valid, from now."),
	note: z.string().max(500).optional().describe("A note signed into the payload."),
});

/** A drafted reusable payload: the exact bytes to sign and the WebAuthn challenge derived from them. */
export const AuthorizationDraftSchema = z
	.object({
		payload: z.string().describe("Base64 of the exact CBOR payload bytes."),
		id: z.string().describe("Hex SHA-256 of the payload bytes."),
		challenge: z.string().describe("Base64url of the WebAuthn challenge derived from the payload."),
		decoded: DecodedAuthorizationPayloadSchema,
	})
	.meta({ id: "AuthorizationDraft" });

export const AuthorizationDraftResponseSchema = z.object({ draft: AuthorizationDraftSchema });

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
	authorization: PendingAuthorizationSchema.nullable().describe("Null when no plan is written yet."),
});

export const TaskGroupAuthorizationResponseSchema = z.object({
	taskGroup: TaskGroupPendingSchema.nullable().describe("Null when no plan is written yet."),
});

/**
 * Privileged-task authorization: the options a waiting task offers its owner, the payload to sign,
 * pending views and the administrator's list (doc/design/privilege.md "Authorization path").
 * The types are derived from their schemas in `schemas/authorizations.ts`.
 */

import type { z } from "zod";
import type {
	AuthorizationDraftBodySchema,
	AuthorizationDraftSchema,
	AuthorizationMethodSchema,
	AuthorizationOptionSchema,
	AuthorizationPathSchema,
	AuthorizationSummarySchema,
	AwaitingNodeAuthorizationOptionSchema,
	DecodedAuthorizationPayloadSchema,
	LocalWindowAuthorizationOptionSchema,
	PendingAuthorizationOptionSchema,
	PendingAuthorizationSchema,
	PendingPasskeySchema,
	PendingPayloadViewSchema,
	PendingSignOptionSchema,
	PendingSignPayloadSchema,
	PlannedPathEntrySchema,
	RejectAuthorizationBodySchema,
	ReusableScopeSchema,
	SignAuthorizationOptionSchema,
	SubmitAuthorizationBodySchema,
	TaskAuthorizationRejectionSchema,
	TaskAuthorizationViewSchema,
	TaskGroupPendingSchema,
	TaskGroupPendingTaskSchema,
} from "./schemas/authorizations.ts";

/** The two paths a crha rejection can rule out. */
export type AuthorizationPath = z.infer<typeof AuthorizationPathSchema>;

/** One trust entry of a `sign` option. */
export type PlannedPathEntry = z.infer<typeof PlannedPathEntrySchema>;

/** The exact payload a `sign` option asks the owner to sign, as stored on the task record. */
export type PendingPayloadView = z.infer<typeof PendingPayloadViewSchema>;

/** The decoded form of a pending authorization payload. */
export type DecodedAuthorizationPayload = z.infer<typeof DecodedAuthorizationPayloadSchema>;

/** One of the owner's Passkeys the node trusts for the payload. */
export type PendingPasskey = z.infer<typeof PendingPasskeySchema>;

/** The payload of a `sign` option as the owner's waiting page renders it. */
export type PendingSignPayload = z.infer<typeof PendingSignPayloadSchema>;

/** A `sign` option: the payload plus the trust entries that would accept it. */
export type SignAuthorizationOption = z.infer<typeof SignAuthorizationOptionSchema>;

/** A `local_window` option: open a window on this node. */
export type LocalWindowAuthorizationOption = z.infer<typeof LocalWindowAuthorizationOptionSchema>;

/** The owner already signed; the task is sent when its absent node is back. */
export type AwaitingNodeAuthorizationOption = z.infer<typeof AwaitingNodeAuthorizationOptionSchema>;

/** One option a waiting task or task group offers its owner. */
export type AuthorizationOption = z.infer<typeof AuthorizationOptionSchema>;

/** A `sign` option as the owner's waiting page renders it. */
export type PendingSignOption = z.infer<typeof PendingSignOptionSchema>;

/** One option the owner's waiting page renders. */
export type PendingAuthorizationOption = z.infer<typeof PendingAuthorizationOptionSchema>;

/** The options a waiting task's or task group's owner can take. */
export type PendingAuthorization = z.infer<typeof PendingAuthorizationSchema>;

export type TaskAuthorizationRejection = z.infer<typeof TaskAuthorizationRejectionSchema>;

/** The authorization state of a privileged task (doc/design/privilege.md "Server-side authorization"). */
export type TaskAuthorizationView = z.infer<typeof TaskAuthorizationViewSchema>;

export type TaskGroupPendingTask = z.infer<typeof TaskGroupPendingTaskSchema>;

export type TaskGroupPending = z.infer<typeof TaskGroupPendingSchema>;

/** Body of `POST /tasks/:id/authorization/reject` and `POST /task-groups/:id/authorization/reject`. */
export type RejectAuthorizationBody = z.infer<typeof RejectAuthorizationBodySchema>;

/** Body of `POST /api/authorizations`. */
export type SubmitAuthorizationBody = z.infer<typeof SubmitAuthorizationBodySchema>;

/** One stored authorization (doc/design/privilege.md "Authorizations"). */
export type AuthorizationSummary = z.infer<typeof AuthorizationSummarySchema>;

/** The methods an authorization's prefix limit can name. */
export type AuthorizationMethod = z.infer<typeof AuthorizationMethodSchema>;

/** What a short reusable authorization for a waiting request covers. */
export type ReusableScope = z.infer<typeof ReusableScopeSchema>;

/** Body of `POST /api/authorizations/draft`. */
export type AuthorizationDraftBody = z.infer<typeof AuthorizationDraftBodySchema>;

/** A drafted reusable payload, ready to sign. */
export type AuthorizationDraft = z.infer<typeof AuthorizationDraftSchema>;

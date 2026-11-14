/**
 * Privileged-task authorization: plans, the payload to sign, pending views
 * and the administrator's list (doc/design/privilege.md "Authorization path").
 * The types are derived from their schemas in `schemas/authorizations.ts`.
 */

import type { z } from "zod";
import type {
	AuthorizationPathSchema,
	AuthorizationSummarySchema,
	DecodedAuthorizationPayloadSchema,
	PendingAuthorizationSchema,
	PendingPasskeySchema,
	PendingPayloadViewSchema,
	PlannedPathEntrySchema,
	PlannedPathViewSchema,
	RejectAuthorizationBodySchema,
	SubmitAuthorizationBodySchema,
	TaskAuthorizationPlanViewSchema,
	TaskAuthorizationRejectionSchema,
	TaskAuthorizationViewSchema,
	TaskGroupPendingSchema,
	TaskGroupPendingTaskSchema,
} from "./schemas/authorizations.ts";

/** The three ways a node can accept a privileged task. */
export type AuthorizationPath = z.infer<typeof AuthorizationPathSchema>;

/** One entry of a planned path. */
export type PlannedPathEntry = z.infer<typeof PlannedPathEntrySchema>;

/** One path of a task's authorization plan (doc/design/privilege.md "Authorization path"). */
export type PlannedPathView = z.infer<typeof PlannedPathViewSchema>;

export type TaskAuthorizationPlanView = z.infer<typeof TaskAuthorizationPlanViewSchema>;

/** The payload the owner has to sign, as stored on the task record. */
export type PendingPayloadView = z.infer<typeof PendingPayloadViewSchema>;

export type TaskAuthorizationRejection = z.infer<typeof TaskAuthorizationRejectionSchema>;

/** The authorization state of a privileged task (doc/design/privilege.md "Server-side authorization"). */
export type TaskAuthorizationView = z.infer<typeof TaskAuthorizationViewSchema>;

/** The decoded form of a pending authorization payload. */
export type DecodedAuthorizationPayload = z.infer<typeof DecodedAuthorizationPayloadSchema>;

/** One of the owner's Passkeys the node trusts for the payload. */
export type PendingPasskey = z.infer<typeof PendingPasskeySchema>;

/** The payload a waiting task's owner has to sign. */
export type PendingAuthorization = z.infer<typeof PendingAuthorizationSchema>;

export type TaskGroupPendingTask = z.infer<typeof TaskGroupPendingTaskSchema>;

export type TaskGroupPending = z.infer<typeof TaskGroupPendingSchema>;

/** Body of `POST /tasks/:id/authorization/reject` and `POST /task-groups/:id/authorization/reject`. */
export type RejectAuthorizationBody = z.infer<typeof RejectAuthorizationBodySchema>;

/** Body of `POST /api/authorizations`. */
export type SubmitAuthorizationBody = z.infer<typeof SubmitAuthorizationBodySchema>;

/** One stored authorization (doc/design/privilege.md "Authorizations"). */
export type AuthorizationSummary = z.infer<typeof AuthorizationSummarySchema>;

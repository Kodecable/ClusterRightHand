/**
 * Privileged-task authorization: plans, the payload to sign, pending views
 * and the administrator's list (doc/design/privilege.md "Authorization path").
 */

import type { RuleMethod } from "./policy.ts";
import type { TaskState } from "./tasks.ts";

/** The three ways a node can accept a privileged task. */
export type AuthorizationPath = "crhs" | "user" | "local";

/** One path of a task's authorization plan (doc/design/privilege.md "Authorization path"). */
export interface PlannedPathView {
	path: AuthorizationPath;
	entries: {
		name: string;
		role: "crhs" | "user" | "local";
		credential?: "sshsig" | "webauthn";
		cosign?: "required" | "available" | "missing";
	}[];
	/** user path only: how long the payload is valid, capped by the strictest accepting entry's max_ttl. */
	ttlMs?: number;
}

export interface TaskAuthorizationPlanView {
	paths: PlannedPathView[];
	/** Why there is no usable path; set exactly when `paths` is empty. */
	reason?: string;
}

/** The payload the owner has to sign, as stored on the task record. */
export interface PendingPayloadView {
	/** Base64 of the exact CBOR payload bytes. */
	payload: string;
	/** Hex SHA-256 of the payload bytes: the authorization id a submission carries. */
	id: string;
	/** ISO 8601 deadline; never null for a planned user path. */
	deadline: string | null;
	/** The task ids the payload covers. */
	taskIds: string[];
	/** The attempt every covered task uses (a task group shares the highest one). */
	attempt: number;
}

export interface TaskAuthorizationRejection {
	code: string;
	message: string;
	/** The attempt crha rejected. */
	attempt: number;
	at: string;
}

/** The authorization state of a privileged task (doc/design/privilege.md "Server-side authorization"). */
export interface TaskAuthorizationView {
	/** The plan computed from the trust summary of the last attempt. */
	plan: TaskAuthorizationPlanView;
	/** Paths a crha rejection already ruled out for this task. */
	tried: AuthorizationPath[];
	/** The path the last `task.start` used; null when nothing was sent yet. */
	dispatchedPath: AuthorizationPath | null;
	/** The `authorizations.id` of the last signature sent (crhs's or the owner's). */
	payloadId: string | null;
	/** The attempt of the last `task.start`. */
	attempt: number;
	/** Hex digest of the TrustSummary the plan was computed from. */
	trustDigest: string | null;
	/** Always null in a task view: the payload is served only by its own endpoint. */
	pending: PendingPayloadView | null;
	/** The attempt a `local.request` was sent for; null when none is outstanding. */
	local: { attempt: number } | null;
	lastRejection: TaskAuthorizationRejection | null;
	updatedAt: string;
}

/** The decoded form of a pending authorization payload. */
export interface DecodedAuthorizationPayload {
	nodes: string[];
	command:
		| { method: RuleMethod; match: "exact"; target: string; specSha256: string }
		| { method: RuleMethod; match: "prefix"; target: string }
		| null;
	issuedAt: string;
	deadline: string | null;
	taskIds: string[] | null;
	attempt: number | null;
	note: string;
}

/** One of the owner's Passkeys the node trusts for the payload. */
export interface PendingPasskey {
	credentialId: string;
	name: string;
	rpId: string;
	origins: string[];
	requireUv: boolean;
	/** The trust entry that would accept it. */
	entry: string;
}

/** The payload a waiting task's owner has to sign. */
export interface PendingAuthorization {
	id: string;
	payload: string;
	decoded: DecodedAuthorizationPayload;
	challenge: string;
	deadline: string | null;
	taskIds: string[];
	attempt: number;
	passkeys: PendingPasskey[];
	localRequested: boolean;
	lastRejection: TaskAuthorizationView["lastRejection"];
	tried: AuthorizationPath[];
}

export interface TaskGroupPendingTask {
	id: string;
	nodeId: string;
	nodeName: string;
	attempt: number;
	state: TaskState;
	localRequested: boolean;
	lastRejection: TaskAuthorizationView["lastRejection"];
	tried: AuthorizationPath[];
}

export interface TaskGroupPending {
	authorization: PendingAuthorization;
	tasks: TaskGroupPendingTask[];
}

/** One stored authorization (doc/design/privilege.md "Authorizations"). */
export interface AuthorizationSummary {
	id: string;
	issuerUserId: string | null;
	issuerUsername: string | null;
	nodes: string[];
	command: DecodedAuthorizationPayload["command"];
	taskIds: string[] | null;
	attempt: number | null;
	note: string;
	issuedAt: string | null;
	deadline: string | null;
	createdAt: string;
}

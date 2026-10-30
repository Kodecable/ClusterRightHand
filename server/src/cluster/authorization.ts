/**
 * The authorization state of one task, stored as JSON in `tasks.authorization` and shown by the task
 * views (doc/m4.md#crhs-侧数据): the last plan, the paths already tried, the signature that was sent,
 * the attempt and the last rejection from crha. The state outlives a re-plan, so a retry never sends
 * the same crhs signature path twice (D83).
 *
 * While a task waits for its owner, `pending` holds the exact payload bytes the owner must sign. They
 * are stored, not recomputed, so the same payload survives a crhs restart and only changes on a
 * re-plan (a new attempt or a changed trust digest, doc/m4.md#阶段).
 */
import type { Signature } from "@crh/protocol";
import type { AuthorizationPath, AuthorizationPlan, PlannedPath } from "../privilege/planner.ts";

/** One path of a plan, flattened for display. */
export interface PlannedPathView {
	path: AuthorizationPath;
	/** The trust entries that would accept the authorization; one name for crhs and local. */
	entries: {
		name: string;
		role: "crhs" | "user" | "local";
		/** The owner's credential a user entry matches. */
		credential?: "sshsig" | "webauthn";
		/** `require-cosign` requested by the entry, and whether the node offers a crhs cosignature. */
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

/** The payload the owner has to sign (doc/m4.md M4.4). */
export interface PendingPayloadView {
	/** Base64 of the exact CBOR payload bytes; `crha grant --payload` and WebAuthn sign exactly these. */
	payload: string;
	/** Hex SHA-256 of the payload bytes: the authorization id a submission carries. */
	id: string;
	/** ISO 8601 deadline; never null for a planned user path (one-shot authorizations need one). */
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

export interface TaskAuthorizationRecord {
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
	/** The payload to sign while the task waits for the owner; null otherwise. */
	pending: PendingPayloadView | null;
	/** The attempt a `local.request` was sent for; null when none is outstanding. */
	local: { attempt: number } | null;
	lastRejection: TaskAuthorizationRejection | null;
	updatedAt: string;
}

function pathView(path: PlannedPath): PlannedPathView {
	switch (path.path) {
		case "crhs":
			return { path: "crhs", entries: [{ name: path.entry.name, role: "crhs" }] };
		case "user":
			return {
				path: "user",
				entries: path.entries.map((entry) => ({
					name: entry.entry.name,
					role: "user",
					credential: entry.credential.kind,
					...(entry.cosignRequired
						? { cosign: entry.cosignAvailable ? ("available" as const) : ("missing" as const) }
						: {}),
				})),
				ttlMs: path.ttlMs,
			};
		case "local":
			return { path: "local", entries: [{ name: path.entry.name, role: "local" }] };
	}
}

/** The plan as it is stored and displayed. */
export function planView(plan: AuthorizationPlan): TaskAuthorizationPlanView {
	return {
		paths: plan.paths.map(pathView),
		...(plan.reason === undefined ? {} : { reason: plan.reason }),
	};
}

/** The stored record; malformed rows are treated as absent (a fresh plan replaces them). */
export function parseTaskAuthorization(json: string | null): TaskAuthorizationRecord | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as Partial<TaskAuthorizationRecord> | null;
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		if (!value.plan || !Array.isArray(value.plan.paths) || !Array.isArray(value.tried)) return null;
		return {
			plan: value.plan,
			tried: value.tried,
			dispatchedPath: value.dispatchedPath ?? null,
			payloadId: value.payloadId ?? null,
			attempt: value.attempt ?? 1,
			trustDigest: value.trustDigest ?? null,
			pending: parsePending(value.pending),
			local: parseLocal(value.local),
			lastRejection: value.lastRejection ?? null,
			updatedAt: value.updatedAt ?? "",
		};
	} catch {
		return null;
	}
}

function parsePending(value: unknown): PendingPayloadView | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const pending = value as Record<string, unknown>;
	if (
		typeof pending.payload !== "string" ||
		typeof pending.id !== "string" ||
		!Array.isArray(pending.taskIds) ||
		typeof pending.attempt !== "number"
	) {
		return null;
	}
	return {
		payload: pending.payload,
		id: pending.id,
		deadline: typeof pending.deadline === "string" ? pending.deadline : null,
		taskIds: pending.taskIds.filter((id): id is string => typeof id === "string"),
		attempt: pending.attempt,
	};
}

function parseLocal(value: unknown): { attempt: number } | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const attempt = (value as Record<string, unknown>).attempt;
	return typeof attempt === "number" ? { attempt } : null;
}

/**
 * The record as a task view shows it: the pending payload itself is only served to the owner by its
 * own endpoint (doc/m4.md M4.4), so every other view drops it.
 */
export function authorizationView(json: string | null): TaskAuthorizationRecord | null {
	const record = parseTaskAuthorization(json);
	return record ? { ...record, pending: null } : null;
}

export function serializeTaskAuthorization(record: TaskAuthorizationRecord): string {
	return JSON.stringify(record);
}

/** A signature in the JSON form of the `authorizations.signatures` column: bytes are base64. */
export function signatureToJson(signature: Signature): Record<string, unknown> {
	switch (signature.kind) {
		case "sshsig":
			return { kind: "sshsig", blob: Buffer.from(signature.blob).toString("base64") };
		case "webauthn":
			return {
				kind: "webauthn",
				credentialId: Buffer.from(signature.credentialId).toString("base64"),
				authenticatorData: Buffer.from(signature.authenticatorData).toString("base64"),
				clientDataJson: Buffer.from(signature.clientDataJson).toString("base64"),
				signature: Buffer.from(signature.signature).toString("base64"),
			};
	}
}

/**
 * The authorization state of one task, stored as JSON in `tasks.authorization` and shown by the task
 * views (doc/design/privilege.md "Server-side authorization"): the options the owner can take, what crha's
 * rejections ruled out (crhs's signature under a window, the owner authorizations up to a time), the
 * signature that was sent, the attempt and the last rejection from crha.
 *
 * While a task waits for its owner, `options` holds the ways to authorize it. A `sign` option carries
 * the exact payload bytes the owner must sign; they are stored, not recomputed, and a sync pass keeps
 * them while they still ask for the same thing (doc/design/privilege.md "Authorization path").
 */
import type { AuthorizationOption, PendingPayloadView, TaskAuthorizationRejection } from "@crh/api";
import type { Signature } from "@crh/protocol";
import type { BuiltAuthorization } from "../privilege/payload.ts";
import { authorizationDeadline } from "../privilege/payload.ts";
import type { PlannedOption } from "../privilege/planner.ts";
import { parseTaskAuthorization, type TaskAuthorizationRecord } from "../privilege/task-authorization.ts";

export type { PendingPayloadView, TaskAuthorizationRecord, TaskAuthorizationRejection };

export { parseTaskAuthorization };

/** The payload as the record stores it and the owner's endpoint serves it. */
function payloadViewOf(authorization: BuiltAuthorization): PendingPayloadView {
	return {
		payload: Buffer.from(authorization.bytes).toString("base64"),
		id: authorization.id,
		deadline: authorizationDeadline(authorization.payload.deadlineMs),
		taskIds: authorization.payload.taskIds ?? [],
		attempt: authorization.payload.attempt ?? 0,
	};
}

/** One planned option as the task record stores it: a `sign` option keeps the exact payload bytes. */
function optionRecord(option: PlannedOption): AuthorizationOption {
	if (option.kind === "local_window") {
		return { kind: "local_window", nodeId: option.nodeId, nodeName: option.nodeName };
	}
	return {
		kind: "sign",
		entries: option.entries.map((entry) => ({
			name: entry.entry.name,
			role: "user",
			credential: entry.credential.kind,
			...(entry.cosignRequired
				? { cosign: entry.cosignAvailable ? ("available" as const) : ("missing" as const) }
				: {}),
		})),
		ttlMs: option.ttlMs,
		payload: payloadViewOf(option.authorization),
	};
}

/** The options of a plan, in the stored form. */
export function optionRecords(options: readonly PlannedOption[]): AuthorizationOption[] {
	return options.map(optionRecord);
}

/**
 * The record as a task view shows it: the payload bytes are only served to the owner by its own
 * endpoint (doc/design/privilege.md "Authorizations"), so every other view drops them.
 */
export function authorizationView(json: string | null): TaskAuthorizationRecord | null {
	const record = parseTaskAuthorization(json);
	if (!record) return null;
	return { ...record, options: record.options.map(withoutPayload) };
}

function withoutPayload(option: AuthorizationOption): AuthorizationOption {
	if (option.kind !== "sign") return option;
	return { ...option, payload: null };
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

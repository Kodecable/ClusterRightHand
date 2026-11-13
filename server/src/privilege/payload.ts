/**
 * Authorization payloads (doc/design/protocol.md "Authorization object"): building the CBOR bytes that get signed and
 * the SHA-256 identifiers used by the database.
 */
import { createHash } from "node:crypto";
import {
	type AuthorizationPayload,
	encodeAuthorizationPayload,
	encode as encodeCbor,
	type TaskSpec,
	taskSpecCodec,
} from "@crh/protocol";
import type { Method } from "../policy/rules.ts";
import { isUuid } from "../util/names.ts";

/**
 * The spec an `exact` authorization binds: a transfer's endpoint is crhs-side routing (which data
 * connection to accept), not part of what the node does, so it is left out of the hash. That lets one
 * approval or group authorization cover every member of a copy while each member has its own transfer id.
 */
function authorizedSpec(spec: TaskSpec): TaskSpec {
	switch (spec.kind) {
		case "file.push":
			return { ...spec, endpoint: { ...spec.endpoint, transferId: "" } };
		case "file.pull":
			return { ...spec, endpoint: { ...spec.endpoint, transferId: "" } };
		default:
			return spec;
	}
}

/** SHA-256(CBOR(spec without the transfer endpoint)): what an `exact` authorization commits to. */
export function specSha256(spec: TaskSpec): Uint8Array {
	return Uint8Array.from(
		createHash("sha256")
			.update(encodeCbor(taskSpecCodec.encode(authorizedSpec(spec))))
			.digest(),
	);
}

/** SHA-256 of the payload bytes: the authorization id used for storage. */
export function authorizationId(payloadBytes: Uint8Array): Uint8Array {
	return Uint8Array.from(createHash("sha256").update(payloadBytes).digest());
}

/** ISO 8601 deadline of a payload crhs stores; every stored authorization has one. */
export function authorizationDeadline(deadlineMs: number | null): string {
	if (deadlineMs === null) throw new Error("authorization has no deadline");
	return new Date(deadlineMs).toISOString();
}

export interface BuiltAuthorization {
	/** The decoded payload, for display and for the `authorizations` row. */
	payload: AuthorizationPayload;
	/** The CBOR bytes to sign (and to hash for the authorization id). */
	bytes: Uint8Array;
	/** SHA-256 of `bytes`, lowercase hex: the `authorizations.id` column. */
	id: string;
}

/** The command restriction of a payload: exact is bound to one spec, prefix only to a target prefix. */
export type AuthorizationCommand =
	| { method: Method; exact: { target: string; specSha256: Uint8Array } }
	| { method: Method; prefix: string };

export interface BuildAuthorizationInput {
	/** Node or node group UUIDs, or exactly `["*"]`. */
	nodes: readonly string[];
	/** null means any method and target. */
	command: AuthorizationCommand | null;
	issuedAtMs: number;
	deadlineMs: number | null;
	/** null/omitted: reusable; otherwise one-shot for these task ids, with `attempt`. */
	taskIds?: readonly string[] | null;
	attempt?: number | null;
	note?: string;
}

/** Builds a payload and its signed bytes; throws SchemaError for values outside the wire schema. */
export function buildAuthorization(input: BuildAuthorizationInput): BuiltAuthorization {
	const taskIds = input.taskIds === undefined || input.taskIds === null ? null : [...input.taskIds];
	for (const node of input.nodes) {
		if (node === "*") {
			if (taskIds !== null) {
				throw new Error('the nodes of a one-shot authorization must be node ids, not "*"');
			}
			continue;
		}
		if (!isUuid(node)) {
			if (taskIds !== null) {
				throw new Error(`the nodes of a one-shot authorization must be node ids, not "${node}"`);
			}
			throw new Error(`authorization nodes must be node or node group UUIDs, not "${node}"`);
		}
	}
	if (taskIds !== null) {
		// A one-shot authorization binds every task id to one node id, by position
		// (doc/design/protocol.md "Authorization object"). Building a payload that violates the binding would only be
		// refused by the node, so fail here instead.
		if (taskIds.length !== input.nodes.length) {
			throw new Error("a one-shot authorization needs exactly one node per task id");
		}
	}
	const command: AuthorizationPayload["command"] =
		input.command === null
			? null
			: "exact" in input.command
				? {
						method: input.command.method,
						match: {
							kind: "exact",
							target: input.command.exact.target,
							specSha256: input.command.exact.specSha256,
						},
					}
				: {
						method: input.command.method,
						match: { kind: "prefix", target: input.command.prefix },
					};
	const payload: AuthorizationPayload = {
		v: 1,
		nodes: [...input.nodes],
		command,
		issuedAtMs: input.issuedAtMs,
		deadlineMs: input.deadlineMs,
		taskIds,
		attempt: input.attempt ?? null,
		note: input.note ?? "",
	};
	const bytes = encodeAuthorizationPayload(payload);
	return { payload, bytes, id: Buffer.from(authorizationId(bytes)).toString("hex") };
}

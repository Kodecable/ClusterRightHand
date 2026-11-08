/**
 * Authorization payloads (doc/protocol.md#授权对象): building the CBOR bytes that get signed and
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

/** SHA-256(CBOR(TaskSpec)): what an `exact` authorization commits to. */
export function specSha256(spec: TaskSpec): Uint8Array {
	return Uint8Array.from(
		createHash("sha256")
			.update(encodeCbor(taskSpecCodec.encode(spec)))
			.digest(),
	);
}

/** SHA-256 of the payload bytes: the authorization id used for storage. */
export function authorizationId(payloadBytes: Uint8Array): Uint8Array {
	return Uint8Array.from(createHash("sha256").update(payloadBytes).digest());
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
		// (doc/protocol.md#授权对象). Building a payload that violates the binding would only be
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

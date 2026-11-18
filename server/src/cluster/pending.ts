/**
 * The options of a task or task group waiting for its owner, as the owner's waiting page shows them
 * (doc/design/privilege.md "Authorization path"). Only the owner may read the sign payload: it is the exact
 * bytes to sign, and nothing about it is secret, but another user has nothing to do with it.
 */
import type {
	AuthorizationOption,
	DecodedAuthorizationPayload,
	LocalWindowAuthorizationOption,
	PendingAuthorization,
	PendingAuthorizationOption,
	PendingPasskey,
	PendingSignOption,
	PendingSignPayload,
	TaskGroupPending,
	TaskGroupPendingTask,
} from "@crh/api";
import type { AuthorizationPayload } from "@crh/protocol";
import { decodeAuthorizationPayload } from "@crh/protocol";
import { webauthnSigningCredentials } from "../privilege/signing-credentials.ts";
import { webauthnChallenge } from "../privilege/webauthn.ts";
import type { Db } from "../storage/db.ts";
import { parseTaskAuthorization, type TaskAuthorizationRecord } from "./authorization.ts";
import { getNode } from "./nodes.ts";
import { parseTrustReport } from "./trust.ts";

/** A decoded payload, in the JSON form the waiting page renders. */
export type DecodedPayloadView = DecodedAuthorizationPayload;

export type { PendingPasskey };

/** The decoded payload of a stored record; null when the row cannot be decoded (fail closed). */
export function decodedPayloadOf(payload: AuthorizationPayload): DecodedPayloadView {
	return {
		nodes: payload.nodes,
		command:
			payload.command === null
				? null
				: payload.command.match.kind === "exact"
					? {
							method: payload.command.method,
							match: "exact",
							target: payload.command.match.target,
							specSha256: Buffer.from(payload.command.match.specSha256).toString("hex"),
						}
					: { method: payload.command.method, match: "prefix", target: payload.command.match.target },
		issuedAt: new Date(payload.issuedAtMs).toISOString(),
		deadline: payload.deadlineMs === null ? null : new Date(payload.deadlineMs).toISOString(),
		taskIds: payload.taskIds,
		attempt: payload.attempt,
		note: payload.note,
	};
}

/** The view of a stored sign payload; null when it cannot be decoded. */
export function signPayloadViewOf(payload: {
	payload: string;
	id: string;
	deadline: string | null;
	taskIds: string[];
	attempt: number;
}): PendingSignPayload | null {
	const bytes = Uint8Array.from(Buffer.from(payload.payload, "base64"));
	let decoded: AuthorizationPayload;
	try {
		decoded = decodeAuthorizationPayload(bytes);
	} catch {
		return null;
	}
	return {
		id: payload.id,
		payload: payload.payload,
		decoded: decodedPayloadOf(decoded),
		challenge: Buffer.from(webauthnChallenge(bytes)).toString("base64url"),
		deadline: payload.deadline,
		taskIds: payload.taskIds,
		attempt: payload.attempt,
		passkeys: [],
	};
}

/** The owner's Passkeys the node trusts for the sign options' entries; empty without a trust summary. */
async function passkeysFor(
	db: Db,
	userId: string,
	nodeId: string,
	options: readonly AuthorizationOption[],
): Promise<PendingPasskey[]> {
	const planned = new Set(
		options
			.filter((option): option is Extract<AuthorizationOption, { kind: "sign" }> => option.kind === "sign")
			.flatMap((option) => option.entries.map((entry) => entry.name)),
	);
	if (planned.size === 0) return [];
	const node = await getNode(db, nodeId);
	const report = node ? parseTrustReport(node.trust_report) : null;
	if (report?.kind !== "ok") return [];
	const credentials = await webauthnSigningCredentials(db, userId);
	const out: PendingPasskey[] = [];
	for (const entry of report.summary.trust) {
		if (entry.role !== "user" || entry.key.kind !== "webauthn" || entry.kinds.length === 0) continue;
		if (!planned.has(entry.name)) continue;
		const credentialId = Buffer.from(entry.key.credentialId).toString("base64url");
		const credential = credentials.find((candidate) => candidate.credentialId === credentialId);
		if (!credential) continue;
		out.push({
			credentialId,
			name: credential.name,
			rpId: entry.key.rpId,
			origins: entry.key.origins,
			requireUv: entry.requireUv,
			entry: entry.name,
		});
	}
	return out;
}

/** One stored option as the owner's waiting page renders it; a sign option with no payload is still preparing. */
async function pendingOption(
	db: Db,
	userId: string,
	nodeId: string,
	option: AuthorizationOption,
): Promise<PendingAuthorizationOption | null> {
	if (option.kind === "local_window") return option satisfies LocalWindowAuthorizationOption;
	if (option.kind === "awaiting_node") return option;
	if (option.payload === null) return null;
	const payload = signPayloadViewOf(option.payload);
	if (!payload) return null;
	payload.passkeys = await passkeysFor(db, userId, nodeId, [option]);
	return { kind: "sign", entries: option.entries, ttlMs: option.ttlMs, payload } satisfies PendingSignOption;
}

/** The options of a stored record, for the owner's endpoint; null when nothing is planned yet. */
async function pendingOptions(
	db: Db,
	userId: string,
	nodeId: string,
	record: TaskAuthorizationRecord,
): Promise<PendingAuthorizationOption[]> {
	const out: PendingAuthorizationOption[] = [];
	for (const option of record.options) {
		const view = await pendingOption(db, userId, nodeId, option);
		if (view) out.push(view);
	}
	return out;
}

/** The waiting page of one task; null when no plan is written yet. */
export async function pendingForTask(
	db: Db,
	row: { node_id: string; on_behalf_of_user_id: string; authorization: string | null },
): Promise<PendingAuthorization | null> {
	const record = parseTaskAuthorization(row.authorization);
	if (!record) return null;
	const options = await pendingOptions(db, row.on_behalf_of_user_id, row.node_id, record);
	if (options.length === 0) return null;
	return { options, lastRejection: record.lastRejection };
}

export type { TaskGroupPendingTask };

export type TaskGroupPendingView = TaskGroupPending;

/**
 * The options of a group's waiting tasks (all of them hold the same one) and the state of each
 * waiting task.
 */
export async function pendingForTaskGroup(
	db: Db,
	taskGroupId: string,
	userId: string,
): Promise<TaskGroupPendingView | null> {
	const rows = await db
		.selectFrom("tasks")
		.selectAll()
		.where("task_group_id", "=", taskGroupId)
		.orderBy("created_at")
		.execute();
	const records = rows.map((row) => ({ row, record: parseTaskAuthorization(row.authorization) }));
	const holder = records.find((entry) => entry.row.state === "awaiting_authorization" && entry.record?.options.length);
	if (!holder?.record) return null;
	const options = await pendingOptions(db, userId, holder.row.node_id, holder.record);
	if (options.length === 0) return null;
	// A group's sign option is one payload; offer every Passkey any waiting node trusts for it.
	for (const option of options) {
		if (option.kind !== "sign") continue;
		const merged: PendingPasskey[] = [];
		const seen = new Set<string>();
		for (const entry of records) {
			if (entry.row.state !== "awaiting_authorization") continue;
			for (const passkey of await passkeysFor(db, userId, entry.row.node_id, entry.record?.options ?? [])) {
				const key = `${passkey.credentialId}\0${passkey.rpId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push(passkey);
			}
		}
		option.payload.passkeys = merged;
	}
	const perTask = records
		.filter((entry) => entry.row.state === "awaiting_authorization")
		.map((entry) => {
			return {
				id: entry.row.id,
				nodeId: entry.row.node_id,
				nodeName: entry.row.node_id,
				attempt: entry.row.attempt,
				state: entry.row.state,
				lastRejection: entry.record?.lastRejection ?? null,
			} satisfies TaskGroupPendingTask;
		});
	// Node names are display data: resolve them in one query, not one per task.
	const nodeRows = await db
		.selectFrom("nodes")
		.select(["id", "name"])
		.where("id", "in", [...new Set(perTask.map((task) => task.nodeId))])
		.execute();
	const names = new Map(nodeRows.map((node) => [node.id, node.name] as const));
	for (const task of perTask) task.nodeName = names.get(task.nodeId) ?? task.nodeId;
	return {
		authorization: { options, lastRejection: holder.record.lastRejection },
		tasks: perTask,
	};
}

/**
 * The pending authorization of a task or task group, as the owner's waiting page shows it
 * (doc/m4.md M4.4, doc/privilege.md#授权路径). Only the owner may read the payload: it is the exact
 * bytes to sign, and nothing about it is secret, but another user has nothing to do with it.
 */
import type {
	DecodedAuthorizationPayload,
	PendingAuthorization,
	PendingPasskey,
	TaskGroupPending,
	TaskGroupPendingTask,
} from "@crh/api";
import type { AuthorizationPayload } from "@crh/protocol";
import { decodeAuthorizationPayload } from "@crh/protocol";
import { webauthnCredentials } from "../privilege/credentials.ts";
import { webauthnChallenge } from "../privilege/webauthn.ts";
import type { Db } from "../storage/db.ts";
import { type PendingPayloadView, parseTaskAuthorization, type TaskAuthorizationRecord } from "./authorization.ts";
import { getNode } from "./nodes.ts";
import { parseTrustReport } from "./trust.ts";

/** A decoded payload, in the JSON form the waiting page renders. */
export type DecodedPayloadView = DecodedAuthorizationPayload;

export type { PendingPasskey };

export type PendingAuthorizationView = PendingAuthorization;

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

/** The view of a stored pending payload; null when it cannot be decoded. */
export function pendingViewOf(pending: PendingPayloadView): PendingAuthorizationView | null {
	const bytes = Buffer.from(pending.payload, "base64");
	let payload: AuthorizationPayload;
	try {
		payload = decodeAuthorizationPayload(Uint8Array.from(bytes));
	} catch {
		return null;
	}
	return {
		id: pending.id,
		payload: pending.payload,
		decoded: decodedPayloadOf(payload),
		challenge: Buffer.from(webauthnChallenge(Uint8Array.from(bytes))).toString("base64url"),
		deadline: pending.deadline,
		taskIds: pending.taskIds,
		attempt: pending.attempt,
		passkeys: [],
		localRequested: false,
		lastRejection: null,
		tried: [],
	};
}

/** The owner's Passkeys that the node trusts for the task's plan; empty without a trust summary. */
async function passkeysFor(
	db: Db,
	userId: string,
	nodeId: string,
	record: TaskAuthorizationRecord | null,
): Promise<PendingPasskey[]> {
	if (!record) return [];
	const node = await getNode(db, nodeId);
	const summary = node ? parseTrustReport(node.trust_report) : null;
	if (summary?.kind !== "ok") return [];
	const planned = new Set(
		record.plan.paths.filter((path) => path.path === "user").flatMap((path) => path.entries.map((entry) => entry.name)),
	);
	if (planned.size === 0) return [];
	const credentials = await webauthnCredentials(db, userId);
	const out: PendingPasskey[] = [];
	for (const entry of summary.summary.trust) {
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

/** The waiting page of one task; null when it has no pending payload. */
export async function pendingForTask(
	db: Db,
	row: { node_id: string; on_behalf_of_user_id: string; authorization: string | null },
): Promise<PendingAuthorizationView | null> {
	const record = parseTaskAuthorization(row.authorization);
	const pending = record?.pending;
	if (!pending) return null;
	const view = pendingViewOf(pending);
	if (!view) return null;
	return {
		...view,
		passkeys: await passkeysFor(db, row.on_behalf_of_user_id, row.node_id, record),
		localRequested: record?.local !== null && record?.local !== undefined,
		lastRejection: record?.lastRejection ?? null,
		tried: record?.tried ?? [],
	};
}

export type { TaskGroupPendingTask };

export type TaskGroupPendingView = TaskGroupPending;

/**
 * The shared payload of a group's waiting tasks (all of them hold the same one, D88) and the state
 * of each task, including those whose plan has no user path.
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
	const holder = records.find((entry) => entry.row.state === "awaiting_authorization" && entry.record?.pending);
	if (!holder?.record?.pending) return null;
	const base = pendingViewOf(holder.record.pending);
	if (!base) return null;
	const perTask = await Promise.all(
		records
			.filter((entry) => entry.row.state === "awaiting_authorization")
			.map(async (entry) => {
				const node = await getNode(db, entry.row.node_id);
				return {
					id: entry.row.id,
					nodeId: entry.row.node_id,
					nodeName: node?.name ?? entry.row.node_id,
					attempt: entry.row.attempt,
					state: entry.row.state,
					localRequested: entry.record?.local !== null && entry.record?.local !== undefined,
					lastRejection: entry.record?.lastRejection ?? null,
					tried: entry.record?.tried ?? [],
				} satisfies TaskGroupPendingTask;
			}),
	);
	// The group payload is one signature for every node; offer every Passkey that any waiting node trusts.
	const merged: PendingPasskey[] = [];
	const seen = new Set<string>();
	for (const entry of records) {
		if (entry.row.state !== "awaiting_authorization") continue;
		for (const passkey of await passkeysFor(db, userId, entry.row.node_id, entry.record)) {
			const key = `${passkey.credentialId}\0${passkey.rpId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(passkey);
		}
	}
	return { authorization: { ...base, passkeys: merged }, tasks: perTask };
}

/**
 * The options of a task or task group waiting for its owner, as the owner's waiting page shows them
 * (doc/design/privilege.md "Authorization path"). Only the owner may read the sign payload and the spec it
 * binds: they are the exact bytes to sign and what those bytes cover, and nothing about them is secret, but
 * another user has nothing to do with them.
 */
import type {
	AuthorizationOption,
	AuthorizationPhase,
	DecodedAuthorizationPayload,
	LocalWindowAuthorizationOption,
	PendingAuthorization,
	PendingAuthorizationOption,
	PendingPasskey,
	PendingSignOption,
	PendingSignPayload,
	ReusableScope,
	TaskGroupPending,
	TaskGroupPendingTask,
} from "@crh/api";
import type { AuthorizationPayload } from "@crh/protocol";
import { decodeAuthorizationPayload } from "@crh/protocol";
import { privilegedTarget } from "../privilege/guard.ts";
import { webauthnSigningCredentials } from "../privilege/signing-credentials.ts";
import { webauthnChallenge } from "../privilege/webauthn.ts";
import type { Db } from "../storage/db.ts";
import { parseTaskAuthorization, type TaskAuthorizationRecord } from "./authorization.ts";
import { getNode } from "./nodes.ts";
import { specFromRow } from "./spec.ts";
import { parseTrustReport } from "./trust.ts";

/** A decoded payload, in the JSON form the waiting page renders. */
export type DecodedPayloadView = DecodedAuthorizationPayload;

/** A signature wait's phase and the view its owner's page renders; the view is non-null exactly when `waiting`. */
export interface AuthorizationWait<T> {
	phase: AuthorizationPhase;
	view: T | null;
}

export type { PendingPasskey };

/** The decoded payload of a stored record; null when the row cannot be decoded (fail closed). */
export function decodedPayloadOf(payload: AuthorizationPayload): DecodedPayloadView {
	return {
		nodes: payload.nodes,
		command:
			payload.command === null
				? null
				: payload.command.kind === "spec"
					? { match: "spec", specSha256: Buffer.from(payload.command.value).toString("hex") }
					: { method: payload.command.method, match: "prefix", target: payload.command.target },
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
	spec: string;
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
		spec: payload.spec,
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

/**
 * What a short reusable authorization for these waiting tasks covers (doc/design/webui.md "Shared components"):
 * their nodes and the one method they use, so an empty prefix of that method covers every one of them.
 * file.write covers file.read, so reads and writes together take file.write. Tasks that also run commands,
 * or a spec that cannot be read, leave no scope: one prefix limit carries one method.
 */
export function reusableScopeOf(tasks: readonly { nodeId: string; spec: string | null }[]): ReusableScope | null {
	const nodes: string[] = [];
	const methods = new Set<string>();
	for (const task of tasks) {
		try {
			methods.add(privilegedTarget(specFromRow(task.spec, "task")).method);
		} catch {
			return null;
		}
		if (!nodes.includes(task.nodeId)) nodes.push(task.nodeId);
	}
	if (nodes.length === 0) return null;
	if (methods.size === 1) {
		const [method] = methods;
		if (method === "exec" || method === "file.read" || method === "file.write") return { nodes, method };
		return null;
	}
	if (methods.size === 2 && methods.has("file.read") && methods.has("file.write"))
		return { nodes, method: "file.write" };
	return null;
}

/**
 * Whether every node has a planned user entry that accepts a reusable prefix authorization: one that requires
 * neither a bound spec nor task ids. An entry that requires crhs's cosignature takes one with a cosign ticket
 * for each use (doc/design/privilege.md "Cosigning"), so it counts when its cosignature is available. crha
 * refuses a `max_ttl` under five minutes, so lifetime never rules a short one out. A node without a trust
 * summary is not known to accept it.
 */
async function reusableAcceptedOn(
	db: Db,
	nodeIds: readonly string[],
	entryNames: ReadonlySet<string>,
): Promise<boolean> {
	for (const nodeId of nodeIds) {
		const node = await getNode(db, nodeId);
		const report = node ? parseTrustReport(node.trust_report) : null;
		if (report?.kind !== "ok") return false;
		const accepts = report.summary.trust.some(
			(entry) =>
				entry.role === "user" &&
				entryNames.has(entry.name) &&
				entry.kinds.includes("execute") &&
				!entry.requireSpec &&
				!entry.requireTask,
		);
		if (!accepts) return false;
	}
	return true;
}

/** The reusable scope of a sign option: the tasks' scope, when the nodes' planned entries would accept it. */
async function signOptionScope(
	db: Db,
	option: PendingSignOption,
	tasks: readonly { nodeId: string; spec: string | null }[],
): Promise<ReusableScope | null> {
	const scope = reusableScopeOf(tasks);
	if (!scope) return null;
	// An entry whose cosignature is missing cannot use the authorization; the planned ones can.
	const names = new Set(
		option.entries.filter((entry) => entry.role === "user" && entry.cosign !== "missing").map((entry) => entry.name),
	);
	return (await reusableAcceptedOn(db, scope.nodes, names)) ? scope : null;
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
	return {
		kind: "sign",
		entries: option.entries,
		...(option.fingerprints && option.fingerprints.length > 0 ? { fingerprints: option.fingerprints } : {}),
		ttlMs: option.ttlMs,
		payload,
		reusableScope: null,
	} satisfies PendingSignOption;
}

/** The options of a stored record, for the owner's endpoint; empty when nothing is planned yet. */
export async function pendingAuthorizationOptions(
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

/** The waiting page of one task, with the phase of its wait; the view is non-null exactly when `waiting`. */
export async function pendingForTask(
	db: Db,
	row: {
		state: string;
		node_id: string;
		on_behalf_of_user_id: string;
		authorization: string | null;
		spec: string | null;
	},
): Promise<AuthorizationWait<PendingAuthorization>> {
	// The row carries its state and its planned options together, so the phase cannot race a second read:
	// any state but `awaiting_authorization` means the wait already ended, whatever settled it.
	if (row.state !== "awaiting_authorization") return { phase: "ended", view: null };
	const record = parseTaskAuthorization(row.authorization);
	if (!record) return { phase: "preparing", view: null };
	const options = await pendingAuthorizationOptions(db, row.on_behalf_of_user_id, row.node_id, record);
	if (options.length === 0) return { phase: "preparing", view: null };
	for (const option of options) {
		if (option.kind === "sign") {
			option.reusableScope = await signOptionScope(db, option, [{ nodeId: row.node_id, spec: row.spec }]);
		}
	}
	return { phase: "waiting", view: { options, lastRejection: record.lastRejection } };
}

export type { TaskGroupPendingTask };

export type TaskGroupPendingView = TaskGroupPending;

/**
 * The options of a group's waiting tasks (all of them hold the same one), the state of each waiting
 * task, and the phase of the wait. A group's wait ends like its members': the group is `waiting` only
 * with a planned view, `preparing` while a member still waits for a signature without one, and `ended`
 * once none does. The phase follows the member rows read here rather than `groupState`: `syncGroupState`
 * re-derives the group's state from its members in a later write, so right after the last member is
 * signed the group row can still say `awaiting_authorization`, and trusting that stale value would make
 * the panel flash "Preparing + Reject". Only a group with no member rows at all yet, where there is no
 * member state to trust, falls back to the group row.
 */
export async function pendingForTaskGroup(
	db: Db,
	taskGroupId: string,
	userId: string,
	groupState: string,
): Promise<AuthorizationWait<TaskGroupPendingView>> {
	const rows = await db
		.selectFrom("tasks")
		.selectAll()
		.where("task_group_id", "=", taskGroupId)
		.orderBy("created_at")
		.execute();
	const waitingMembers = rows.filter((row) => row.state === "awaiting_authorization");
	const records = rows.map((row) => ({ row, record: parseTaskAuthorization(row.authorization) }));
	const holder = records.find((entry) => entry.row.state === "awaiting_authorization" && entry.record?.options.length);
	if (!holder?.record) {
		// The members were read together, so their states decide the phase; the group row can lag them.
		const phase: AuthorizationPhase =
			waitingMembers.length > 0 || (rows.length === 0 && groupState === "awaiting_authorization")
				? "preparing"
				: "ended";
		return { phase, view: null };
	}
	const options = await pendingAuthorizationOptions(db, userId, holder.row.node_id, holder.record);
	if (options.length === 0) return { phase: "preparing", view: null };
	const waiting = waitingMembers.map((row) => ({ nodeId: row.node_id, spec: row.spec }));
	// A group's sign option is one payload; offer every Passkey any waiting node trusts for it.
	for (const option of options) {
		if (option.kind !== "sign") continue;
		option.reusableScope = await signOptionScope(db, option, waiting);
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
		phase: "waiting",
		view: {
			authorization: { options, lastRejection: holder.record.lastRejection },
			tasks: perTask,
		},
	};
}

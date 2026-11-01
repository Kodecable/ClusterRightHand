/**
 * The authorization of a privileged task (doc/privilege.md#授权路径, doc/m4.md M4.4): planning which
 * path the node would accept, reusing an authorization the owner already stored, asking for the
 * owner's signature or a local approval, sending the signed `task.start`, retrying with a higher
 * attempt after a rejection, and storing and revoking what was issued.
 */
import {
	type Authorization,
	type AuthorizationPayload,
	authorizationCodec,
	ConnectionError,
	decodeAuthorizationPayload,
	encode as encodeCbor,
	type LocalDecision,
	type LocalRequest,
	type LocalState,
	type LocalWithdraw,
	MAX_FRAME_BYTES,
	ProtocolError,
	RemoteError,
	type Signature,
	type TaskSpec,
	type TrustSummary,
} from "@crh/protocol";
import type { Selectable, Updateable } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import type { AuthzDecision, AuthzSignature } from "../privilege/authz.ts";
import { authzEntryFromTrust, decide, STEP } from "../privilege/authz.ts";
import { ownerCredentials } from "../privilege/credentials.ts";
import type { BuiltAuthorization } from "../privilege/payload.ts";
import {
	type AuthorizationPath,
	buildTaskGroupAuthorization,
	type PlannedLocalPath,
	type PlannedUserPath,
	planAuthorization,
	USER_AUTHORIZATION_TTL_MS,
} from "../privilege/planner.ts";
import {
	assertSubmittingUser,
	encodeAuthorization,
	entryBelongsToUser,
	loadUserSigningMaterial,
	type SubmittedAuthorization,
	signaturesFromJson,
	signaturesToJson,
	type UserSigningMaterial,
	verifyAgainstTrust,
} from "../privilege/submission.ts";
import type { TaskState as TaskRowState, TasksTable } from "../storage/schema.ts";
import { defaultOrgId, UserError } from "../users/service.ts";
import { errorText } from "../util/errors.ts";
import {
	type PendingPayloadView,
	parseTaskAuthorization,
	planView,
	serializeTaskAuthorization,
	signatureToJson,
	type TaskAuthorizationRecord,
} from "./authorization.ts";
import type { ClusterCore } from "./core.ts";
import { now } from "./core.ts";
import type { NodeLink } from "./links.ts";
import { waitTrust } from "./links.ts";
import { getNode, type NodeRow } from "./nodes.ts";
import { specFromRow } from "./spec.ts";
import { taskStartOf } from "./task-start.ts";
import {
	dropLive,
	endTask,
	finish,
	groupEnded,
	newLive,
	onAccepted,
	syncGroupState,
	updateTask,
} from "./task-state.ts";
import { parseTrustReport, trustUnavailableMessage } from "./trust.ts";
import { type ApprovalRecord, AUTHORIZATION_CODES, AUTHORIZATION_WAIT_MS } from "./types.ts";

/** How far an authorization's issued_at may be ahead of crhs's clock before it is refused. */
const SUBMISSION_CLOCK_SKEW_MS = 60_000;
/** A task's local approval request note, shown by `crha pending`. */
const LOCAL_REQUEST_NOTE = "crhs asks for this task to be approved on the node";

/** A task claimed for an owner authorization and ready to be sent. */
interface ClaimedAuthorization {
	start: ReturnType<typeof taskStartOf>;
	record: TaskAuthorizationRecord;
	input: Uint8Array;
	cosigned: boolean;
}

/** A waiting task of a submission, judged against its node's trust summary before anything is claimed. */
interface JudgedSubmission {
	row: Selectable<TasksTable>;
	node: NodeRow;
	link: NodeLink;
	/** The user's signatures plus the cosignature this node needed (when one was needed). */
	signatures: Signature[];
	cosigned: boolean;
}

/** A waiting task of a submission that was judged and claimed; sending happens after all of them. */
interface PreparedSubmission {
	link: NodeLink;
	nodeId: string;
	claim: ClaimedAuthorization;
	/** Every signature the Authorization carries (the union of the group's cosignatures included). */
	signatures: Signature[];
}

// ---- planning and parking ----

/**
 * Computes the authorization plan of a privileged task and acts on it, in this order
 * (doc/privilege.md#授权路径): an authorization the owner already stored that covers the task,
 * crhs's own signature, the owner's signature or a local approval. With no usable path the task
 * ends rejected and says why.
 */
export async function planPrivileged(
	core: ClusterCore,
	id: string,
	node: NodeRow,
	link: NodeLink,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	opts: { timeoutMs?: number },
	from: readonly TaskRowState[],
): Promise<void> {
	const row = await core.row(id);
	if (!row || !from.includes(row.state)) return;
	// A member of a group that already ended (interrupted by a restart) never dispatches again.
	if (await groupEnded(core, row.task_group_id)) return;
	if (!link.conn.supportsForward) {
		// A crha without the M4 names cannot take part in forward whatever its reported mode says
		// (doc/protocol.md#握手载荷).
		await finishAuthorization(
			core,
			id,
			row,
			"failed",
			"privileged_unsupported",
			"the node's crha does not support forward",
			null,
		);
		return;
	}
	await waitTrust(core, link);
	const fresh = await getNode(core.db, node.id);
	const report = fresh ? parseTrustReport(fresh.trust_report) : null;
	// A report kept from a previous connection is stale until this connection reports again: the node's
	// trust configuration may have changed while it was away (doc/privilege.md#信任缓存).
	if (!fresh || !link.trustFresh || report?.kind !== "ok") {
		const message = link.trustFresh
			? trustUnavailableMessage(report)
			: "the node has not reported a trust summary on this connection";
		await finishAuthorization(core, id, row, "failed", "privileged_unavailable", message, null);
		return;
	}
	const summary = report.summary;
	const previous = parseTaskAuthorization(row.authorization);
	const tried = previous ? [...previous.tried] : [];
	// Without a signing key crhs cannot take its own path; treating it as tried keeps the plan honest.
	if (!core.authorizationKey && !tried.includes("crhs")) tried.push("crhs");
	const plan = planAuthorization({
		summary,
		nodeId: node.id,
		nodeGroups: summary.groups,
		task: { id, attempt: row.attempt, spec, privileged: true },
		taskGroup: row.task_group_id !== null,
		owner: await ownerCredentials(core.db, row.on_behalf_of_user_id),
		...(core.authorizationKey ? { crhsFingerprint: core.authorizationKey.fingerprint } : {}),
		tried,
		now: Date.now(),
	});
	const record: TaskAuthorizationRecord = {
		plan: planView(plan),
		tried,
		dispatchedPath: previous?.dispatchedPath ?? null,
		payloadId: previous?.payloadId ?? null,
		attempt: row.attempt,
		trustDigest: fresh.trust_digest,
		pending: previous?.pending ?? null,
		local: previous?.local ?? null,
		lastRejection: previous?.lastRejection ?? null,
		updatedAt: new Date().toISOString(),
	};
	const crhsPath = plan.paths.find((path) => path.path === "crhs");
	if (crhsPath?.path === "crhs") {
		await dispatchCrhs(core, id, row, node, link, spec, inputBytes, opts, record, crhsPath.authorization, from);
		return;
	}
	// The owner may already have signed a reusable authorization that covers this command
	// (doc/privilege.md#授权路径 step 3): use it instead of asking for a signature again. A payload
	// crha already rejected is not retried automatically, or the retry would loop.
	const skip = new Set<string>();
	if (previous?.lastRejection && previous.payloadId) skip.add(previous.payloadId);
	const reusable = await findReusableAuthorization(core, row, node, summary, spec, skip);
	if (reusable) {
		const dispatched = await dispatchOwnerAuthorization(
			core,
			row,
			node,
			link,
			reusable.submitted,
			reusable.cosigned,
			from,
			inputBytes,
		);
		if (dispatched) return;
	}
	const userPath = plan.paths.find((path): path is PlannedUserPath => path.path === "user");
	const localPath = plan.paths.find((path): path is PlannedLocalPath => path.path === "local");
	if (!userPath && !(localPath && row.task_group_id === null)) {
		const code = record.lastRejection?.code ?? "authorization_required";
		const reason = plan.reason ?? "no one on this node can authorize this command";
		const message = record.lastRejection === null ? reason : `${record.lastRejection.message}; ${reason}`;
		await finishAuthorization(core, id, row, "rejected", code, message, { ...record, pending: null, local: null });
		return;
	}
	await parkForAuthorization(core, id, row, link, spec, inputBytes, record, userPath, localPath, from);
}

/**
 * Parks the task in `awaiting_authorization`: for a single task it records the exact payload the
 * owner must sign and, when the node offers local approval, requests that too. A task group's
 * shared payload is built across all of the group's waiting tasks (refreshGroupPending).
 */
async function parkForAuthorization(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	link: NodeLink,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	record: TaskAuthorizationRecord,
	userPath: PlannedUserPath | undefined,
	localPath: PlannedLocalPath | undefined,
	from: readonly TaskRowState[],
): Promise<void> {
	const single = row.task_group_id === null;
	const pending = single && userPath ? pendingOf(userPath.authorization) : null;
	const local = single && localPath ? { attempt: row.attempt } : null;
	// The last task.start was rejected (or none was sent): nothing is in flight while the task waits.
	const updated: TaskAuthorizationRecord = {
		...record,
		pending,
		local,
		dispatchedPath: null,
		updatedAt: new Date().toISOString(),
	};
	const parked = await updateTask(core, id, from, {
		state: "awaiting_authorization",
		authorization: serializeTaskAuthorization(updated),
		pending_input: inputBytes.length > 0 ? Buffer.from(inputBytes).toString("base64") : null,
		dispatched_at: null,
		handler_type: "user",
		handler_session_id: null,
	});
	if (!parked) return;
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	core.onChange?.(row.actor_id);
	if (row.task_group_id !== null) {
		// Every waiting task of the group signs one payload covering all of them (D88).
		await refreshGroupPending(core, row.task_group_id);
		return;
	}
	if (localPath) await sendLocalRequest(core, id, link, spec, updated);
}

// ---- local approval (doc/privilege.md#本地批准) ----

/** Sends `local.request` and follows the answer: pending, approved (dispatch) or denied (reject). */
async function sendLocalRequest(
	core: ClusterCore,
	id: string,
	link: NodeLink,
	spec: TaskSpec,
	record: TaskAuthorizationRecord,
): Promise<void> {
	const attempt = record.attempt;
	let state: LocalState;
	try {
		const request: LocalRequest = { taskId: id, attempt, spec, note: LOCAL_REQUEST_NOTE };
		state = (await link.conn.peer.request("local.request", request)) as LocalState;
	} catch (err) {
		if (err instanceof RemoteError && err.code === "local_not_trusted") {
			// The node has no local trust entry after all: drop that path and plan again.
			await dropLocalPath(core, id);
			return;
		}
		if (!(err instanceof ConnectionError)) console.error(`local.request for ${id} failed:`, err);
		// Otherwise the request is sent again after the node's next `ok` trust report.
		return;
	}
	await onLocalState(core, id, attempt, state);
}

/** `local.decision`: the node's local approval or denial, for the attempt it was requested for. */
export async function onLocalDecision(core: ClusterCore, link: NodeLink, decision: LocalDecision): Promise<void> {
	await core.taskQueue.run(decision.taskId, async () => {
		const row = await core.row(decision.taskId);
		if (!row || row.node_id !== link.conn.nodeId || row.state !== "awaiting_authorization") return;
		const record = parseTaskAuthorization(row.authorization);
		if (record?.attempt !== decision.attempt) return;
		await onLocalState(core, decision.taskId, decision.attempt, decision.state);
	});
}

async function onLocalState(core: ClusterCore, id: string, attempt: number, state: LocalState): Promise<void> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization" || row.attempt !== attempt) return;
	if (state.kind === "pending") return;
	const record = parseTaskAuthorization(row.authorization);
	if (state.kind === "denied") {
		const updated = record ? { ...record, pending: null, local: null, updatedAt: new Date().toISOString() } : null;
		await finishAuthorization(core, id, row, "rejected", "authorization_rejected", state.message, updated);
		return;
	}
	// Approved: task.start with the approval instead of an authorization (doc/protocol.md#taskstart).
	const node = await getNode(core.db, row.node_id);
	const link = core.links.get(row.node_id);
	if (!node || !link || link.conn.closed || !link.ready || !record) return;
	// A member of a group that already ended (interrupted by a restart) never dispatches again.
	if (await groupEnded(core, row.task_group_id)) return;
	const spec = specFromRow(row.spec, "task");
	const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
	const updated: TaskAuthorizationRecord = {
		...record,
		pending: null,
		local: null,
		dispatchedPath: "local",
		attempt,
		updatedAt: new Date().toISOString(),
	};
	const claimed = await updateTask(core, id, ["awaiting_authorization"], {
		state: "dispatched",
		dispatched_at: now(),
		authorization: serializeTaskAuthorization(updated),
		pending_input: null,
		handler_type: null,
		handler_session_id: null,
	});
	if (!claimed) return;
	newLive(core, id, node.id, row.output_mode, row.task_group_id);
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	const start = taskStartOf(id, row, spec, { privileged: true, attempt });
	await sendAuthorizedStart(core, link, node.id, id, spec, input, start, updated);
}

/** Drops the local path after the node refused it, then plans again without it. */
async function dropLocalPath(core: ClusterCore, id: string): Promise<void> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return;
	const record = parseTaskAuthorization(row.authorization);
	if (!record) return;
	const updated: TaskAuthorizationRecord = {
		...record,
		local: null,
		tried: [...new Set<AuthorizationPath>([...record.tried, "local"])],
		updatedAt: new Date().toISOString(),
	};
	const res = await core.db
		.updateTable("tasks")
		.set({ authorization: serializeTaskAuthorization(updated) })
		.where("id", "=", id)
		.where("state", "=", "awaiting_authorization")
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) return;
	const node = await getNode(core.db, row.node_id);
	const link = core.links.get(row.node_id);
	if (!node || !link || link.conn.closed || !link.ready) return;
	const spec = specFromRow(row.spec, "task");
	const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
	await planPrivileged(core, id, node, link, spec, input, { timeoutMs: row.timeout_ms ?? undefined }, [
		"awaiting_authorization",
	]);
}

/** Sends local.request again for the node's tasks whose approval request the privileged mode lost. */
export async function resendLocalRequests(core: ClusterCore, link: NodeLink): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("node_id", "=", link.conn.nodeId)
		.where("state", "=", "awaiting_authorization")
		.execute();
	for (const { id } of rows) await core.taskQueue.run(id, () => resendLocalRequest(core, id, link));
}

async function resendLocalRequest(core: ClusterCore, id: string, link: NodeLink): Promise<void> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization" || link.conn.closed || !link.ready) return;
	const record = parseTaskAuthorization(row.authorization);
	if (!record || record.local === null) return;
	await sendLocalRequest(core, id, link, specFromRow(row.spec, "task"), record);
}

/** Withdraws a pending local request (the owner signed, the task was cancelled or re-planned). */
export function withdrawLocal(
	link: NodeLink | undefined,
	taskId: string,
	record: TaskAuthorizationRecord | null,
): void {
	if (!record?.local || !link || link.conn.closed) return;
	const withdraw: LocalWithdraw = { taskId, attempt: record.local.attempt };
	void link.conn.peer.request("local.withdraw", withdraw).catch((err: unknown) => {
		if (!(err instanceof ConnectionError)) console.error(`local.withdraw for ${taskId} failed:`, err);
	});
}

// ---- task groups: one payload for every waiting task (D88) ----

/** Rebuilds the shared payload of a group's waiting tasks from their plans, one signature for all. */
async function refreshGroupPending(core: ClusterCore, groupId: string): Promise<void> {
	await core.groupQueue.run(groupId, async () => {
		const group = await core.db.selectFrom("task_groups").selectAll().where("id", "=", groupId).executeTakeFirst();
		if (!group) return;
		const rows = await core.db
			.selectFrom("tasks")
			.selectAll()
			.where("task_group_id", "=", groupId)
			.orderBy("created_at")
			.execute();
		const entries = rows
			.filter((row) => row.state === "awaiting_authorization")
			.map((row) => ({ row, record: parseTaskAuthorization(row.authorization) }));
		const withUser = entries.filter((entry) => entry.record?.plan.paths.some((path) => path.path === "user"));
		if (withUser.length === 0) {
			for (const entry of entries) await clearGroupPending(core, entry.row, entry.record);
			return;
		}
		// The protocol ties a task.start to the payload's attempt, so all covered tasks move to the
		// highest attempt (doc/protocol.md#授权对象, D88).
		const attempt = Math.max(...withUser.map((entry) => entry.row.attempt));
		const ttlMs = Math.min(...withUser.map((entry) => userPathTtl(entry.record)));
		let spec: TaskSpec;
		try {
			spec = specFromRow(group.spec ?? withUser[0]?.row.spec ?? null, "task group");
		} catch (err) {
			console.warn(`task group ${groupId}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const authorization = buildTaskGroupAuthorization({
			nodeIds: withUser.map((entry) => entry.row.node_id),
			taskIds: withUser.map((entry) => entry.row.id),
			attempt,
			spec,
			ttlMs,
		});
		const pending = pendingOf(authorization);
		const covered = new Set(withUser.map((entry) => entry.row.id));
		for (const row of rows) {
			if (row.state !== "awaiting_authorization") continue;
			const record = parseTaskAuthorization(row.authorization);
			if (!covered.has(row.id)) {
				await clearGroupPending(core, row, record);
				continue;
			}
			if (!record) continue;
			const updated: TaskAuthorizationRecord = {
				...record,
				attempt,
				pending,
				updatedAt: new Date().toISOString(),
			};
			const set: Updateable<TasksTable> = { authorization: serializeTaskAuthorization(updated) };
			if (row.attempt !== attempt) set.attempt = attempt;
			const res = await core.db
				.updateTable("tasks")
				.set(set)
				.where("id", "=", row.id)
				.where("state", "=", "awaiting_authorization")
				.executeTakeFirst();
			if (res.numUpdatedRows === 0n) continue;
			if (row.attempt !== attempt) core.notify(row.id);
		}
	});
}

async function clearGroupPending(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	record: TaskAuthorizationRecord | null,
): Promise<void> {
	if (!record?.pending) return;
	const updated: TaskAuthorizationRecord = { ...record, pending: null, updatedAt: new Date().toISOString() };
	await core.db
		.updateTable("tasks")
		.set({ authorization: serializeTaskAuthorization(updated) })
		.where("id", "=", row.id)
		.where("state", "=", "awaiting_authorization")
		.execute();
}

// ---- the owner's stored and submitted authorizations ----

/**
 * Finds a stored authorization of the task's owner that covers it and that the node's trust
 * summary would accept (doc/privilege.md#授权路径). Reusable ones (no task ids) and one-shot ones
 * for this task with the same attempt qualify; a cosignature is added when the accepting entry
 * needs one and the payload is one-shot.
 */
async function findReusableAuthorization(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	node: NodeRow,
	summary: TrustSummary,
	spec: TaskSpec,
	skip: ReadonlySet<string>,
): Promise<{ submitted: SubmittedAuthorization; cosigned: boolean } | null> {
	const ownerId = row.on_behalf_of_user_id;
	const stored = await core.db
		.selectFrom("authorizations")
		.selectAll()
		.where("issuer_user_id", "=", ownerId)
		.where("org_id", "=", node.org_id)
		.where("revoked_at", "is", null)
		.orderBy("created_at")
		.execute();
	if (stored.length === 0) return null;
	const material = await loadUserSigningMaterial(core.db, ownerId);
	for (const candidate of stored) {
		if (skip.has(candidate.id)) continue;
		const payloadBytes = Uint8Array.from(Buffer.from(candidate.payload, "base64"));
		let payload: AuthorizationPayload;
		try {
			payload = decodeAuthorizationPayload(payloadBytes);
		} catch {
			continue; // a damaged row is never usable (fail closed)
		}
		if (payload.taskIds !== null) {
			if (!payload.taskIds.includes(row.id)) continue;
			if (payload.attempt !== row.attempt) continue;
		}
		const signatures = signaturesFromJson(candidate.signatures);
		if (signatures.length === 0) continue;
		const judged = await judgeOwnerAuthorization(core, {
			payload,
			payloadBytes,
			signatures,
			summary,
			nodeId: node.id,
			task: { id: row.id, attempt: row.attempt, spec },
			material,
		});
		if (!judged.accepted) continue;
		return {
			submitted: { payload, payloadBytes, signatures: judged.signatures, id: candidate.id },
			cosigned: judged.cosigned,
		};
	}
	return null;
}

/**
 * Judges one owner authorization for one task with the real decision port: which trust entry
 * verifies which signature, whether the node would accept it, and whether a crhs cosignature has
 * to be appended first (doc/privilege.md#联署).
 */
async function judgeOwnerAuthorization(
	core: ClusterCore,
	input: {
		payload: AuthorizationPayload;
		payloadBytes: Uint8Array;
		signatures: Signature[];
		summary: TrustSummary;
		nodeId: string;
		task: { id: string; attempt: number; spec: TaskSpec };
		material: UserSigningMaterial;
	},
): Promise<{
	accepted: boolean;
	signatures: Signature[];
	entry: string | null;
	cosigned: boolean;
	reason: string;
}> {
	const trust = input.summary.trust;
	let signatures = [...input.signatures];
	const judge = (candidates: readonly AuthzSignature[]) =>
		decideOwnerAuthorization({
			now: Date.now(),
			summary: input.summary,
			nodeId: input.nodeId,
			task: input.task,
			payload: input.payload,
			payloadBytes: input.payloadBytes,
			signatures: candidates,
		});
	let authz = await verifyAgainstTrust(signatures, input.payloadBytes, trust);
	let decision = judge(authz);
	let cosigned = false;
	if (decision.result !== "accepted" && decision.step === STEP.cosign && input.payload.taskIds !== null) {
		const cosign = cosignature(core, input.payloadBytes, input.summary);
		if (cosign) {
			signatures = [...signatures, cosign];
			authz = await verifyAgainstTrust(signatures, input.payloadBytes, trust);
			const again = judge(authz);
			if (again.result === "accepted") {
				decision = again;
				cosigned = true;
			}
		}
	}
	if (decision.result !== "accepted") {
		return {
			accepted: false,
			signatures,
			entry: null,
			cosigned,
			reason: decision.step === null ? decision.message : `step ${decision.step}: ${decision.message}`,
		};
	}
	if (!entryBelongsToUser(decision.entry, trust, input.material)) {
		return {
			accepted: false,
			signatures,
			entry: decision.entry,
			cosigned,
			reason: "the accepting trust entry does not belong to the owner's credentials",
		};
	}
	return { accepted: true, signatures, entry: decision.entry, cosigned, reason: "" };
}

/** crhs's cosignature for a payload, when the node trusts its signing key with the cosign kind. */
function cosignature(core: ClusterCore, payloadBytes: Uint8Array, summary: TrustSummary): Signature | null {
	const key = core.authorizationKey;
	if (!key) return null;
	const entry = summary.trust.find(
		(trustee) =>
			trustee.role === "crhs" &&
			trustee.kinds.includes("cosign") &&
			trustee.key.kind === "sshsig" &&
			trustee.key.fingerprint === key.fingerprint,
	);
	if (!entry) return null;
	return { kind: "sshsig", blob: key.sign(payloadBytes) };
}

/**
 * Claims a task for an owner authorization: the attempt is fixed, the pending payload is cleared
 * and the local approval request withdrawn. Sending is separate, so a whole task group can be
 * claimed before the first task.start is sent and a rejection cannot change a sibling's attempt.
 */
async function claimOwnerAuthorization(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	node: NodeRow,
	link: NodeLink,
	submitted: SubmittedAuthorization,
	cosigned: boolean,
	from: readonly TaskRowState[] = ["awaiting_authorization"],
	inputBytes?: Uint8Array,
): Promise<ClaimedAuthorization | null> {
	if (!from.includes(row.state)) return null;
	// A member of a group that already ended (interrupted by a restart) never dispatches again.
	if (await groupEnded(core, row.task_group_id)) return null;
	const oneShot = submitted.payload.taskIds !== null;
	const attempt = oneShot ? (submitted.payload.attempt as number) : row.attempt;
	if (oneShot && attempt !== row.attempt) return null;
	let encoded: Uint8Array;
	try {
		encoded = encodeAuthorization(submitted.payloadBytes, submitted.signatures);
	} catch (err) {
		console.error(`authorization ${submitted.id} cannot be encoded:`, err);
		return null;
	}
	if (encoded.length > MAX_FRAME_BYTES / 2) return null;
	const record = parseTaskAuthorization(row.authorization);
	const updated: TaskAuthorizationRecord = {
		plan: record?.plan ?? { paths: [] },
		tried: record?.tried ?? [],
		dispatchedPath: "user",
		payloadId: submitted.id,
		attempt,
		trustDigest: record?.trustDigest ?? null,
		pending: null,
		local: null,
		lastRejection: record?.lastRejection ?? null,
		updatedAt: new Date().toISOString(),
	};
	withdrawLocal(link, row.id, record);
	const claimed = await updateTask(core, row.id, from, {
		state: "dispatched",
		attempt,
		dispatched_at: now(),
		authorization: serializeTaskAuthorization(updated),
		pending_input: null,
		handler_type: null,
		handler_session_id: null,
	});
	if (!claimed) return null;
	newLive(core, row.id, node.id, row.output_mode, row.task_group_id);
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	// The task no longer waits for a signature; the session it belongs to runs again (doc/agent-runtime.md#会话状态).
	core.onChange?.(row.actor_id);
	if (cosigned) {
		core.auditLater({
			actor: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
			action: "authorization.cosigned",
			target: { type: "authorization", id: submitted.id },
			detail: { node_id: node.id, task_id: row.id, attempt },
		});
	}
	const spec = specFromRow(row.spec, "task");
	// A task that waited has its input in pending_input; a fresh one it only ever had in memory
	// (doc/execution-plane.md#状态机).
	const input = inputBytes ?? (row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0));
	const start = taskStartOf(row.id, row, spec, { privileged: true, attempt, authorizations: [encoded] });
	return { start, record: updated, input, cosigned };
}

/** Claims and sends one owner authorization (the reuse path of a single task). */
async function dispatchOwnerAuthorization(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	node: NodeRow,
	link: NodeLink,
	submitted: SubmittedAuthorization,
	cosigned: boolean,
	from: readonly TaskRowState[] = ["awaiting_authorization"],
	inputBytes?: Uint8Array,
): Promise<boolean> {
	const prepared = await claimOwnerAuthorization(core, row, node, link, submitted, cosigned, from, inputBytes);
	if (!prepared) return false;
	await sendAuthorizedStart(
		core,
		link,
		node.id,
		prepared.start.taskId,
		prepared.start.spec,
		prepared.input,
		prepared.start,
		prepared.record,
	);
	return true;
}

/**
 * POST /api/authorizations: checks a user's authorization, stores it (for display, revocation and
 * reuse) and dispatches every waiting task of that user it covers (doc/m4.md M4.4).
 */
export async function submitAuthorization(
	core: ClusterCore,
	user: SessionUser,
	submitted: SubmittedAuthorization,
): Promise<{ id: string; dispatched: string[] }> {
	const material = await loadUserSigningMaterial(core.db, user.userId);
	await assertSubmittingUser(material, submitted.payloadBytes, submitted.signatures);
	const nowMs = Date.now();
	const { deadlineMs } = submitted.payload;
	if (deadlineMs !== null && deadlineMs < nowMs) {
		throw new UserError(`the authorization expired at ${new Date(deadlineMs).toISOString()}`);
	}
	if (submitted.payload.issuedAtMs > nowMs + SUBMISSION_CLOCK_SKEW_MS) {
		throw new UserError("the authorization was issued in the future");
	}
	const stored = await insertOwnerAuthorization(core, user, submitted);
	core.auditLater({
		actor: { type: "user", id: user.userId, onBehalfOfUserId: user.userId },
		action: "authorization.submitted",
		target: { type: "authorization", id: submitted.id },
		detail: {
			nodes: submitted.payload.nodes,
			command: commandForAudit(submitted.payload.command),
			task_ids: submitted.payload.taskIds,
			attempt: submitted.payload.attempt,
			deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
			duplicate: !stored,
		},
	});
	// A revoked authorization is stored but never used (revocation only ever takes permissions away).
	if (await isRevoked(core, submitted.id)) return { id: submitted.id, dispatched: [] };
	const rows = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("state", "=", "awaiting_authorization")
		.where("on_behalf_of_user_id", "=", user.userId)
		.orderBy("created_at")
		.execute();
	// Judge every covered task first, then claim all of them, then send: a rejection of one
	// task.start must not re-plan (and change the attempt of) a sibling still about to be sent.
	const judged: JudgedSubmission[] = [];
	for (const { id } of rows) {
		const entry = await core.taskQueue.run(id, () => judgeSubmitted(core, id, submitted, material));
		if (entry) judged.push(entry);
	}
	// The Authorization is one object for the whole group (D88), so it carries the union of the
	// cosignatures the covered nodes need; a node ignores a signature of a key it does not trust.
	const keys = new Set(submitted.signatures.map(signatureKey));
	const cosignatures: Signature[] = [];
	for (const entry of judged) {
		for (const signature of entry.signatures) {
			const key = signatureKey(signature);
			if (keys.has(key)) continue;
			keys.add(key);
			cosignatures.push(signature);
		}
	}
	const signatures = [...submitted.signatures, ...cosignatures];
	const prepared: PreparedSubmission[] = [];
	for (const entry of judged) {
		const claim = await core.taskQueue.run(entry.row.id, () =>
			claimOwnerAuthorization(core, entry.row, entry.node, entry.link, { ...submitted, signatures }, entry.cosigned),
		);
		if (!claim) continue;
		prepared.push({ link: entry.link, nodeId: entry.node.id, claim, signatures });
	}
	const dispatched: string[] = [];
	for (const entry of prepared) {
		const { claim } = entry;
		await sendAuthorizedStart(
			core,
			entry.link,
			entry.nodeId,
			claim.start.taskId,
			claim.start.spec,
			claim.input,
			claim.start,
			claim.record,
		);
		dispatched.push(claim.start.taskId);
	}
	if (cosignatures.length > 0) await storeCosignatures(core, submitted, cosignatures);
	return { id: submitted.id, dispatched };
}

/** One waiting task of the submitting user, judged against its node's fresh trust summary. */
async function judgeSubmitted(
	core: ClusterCore,
	id: string,
	submitted: SubmittedAuthorization,
	material: UserSigningMaterial,
): Promise<JudgedSubmission | null> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return null;
	const payload = submitted.payload;
	if (payload.taskIds !== null) {
		if (!payload.taskIds.includes(id) || payload.attempt !== row.attempt) return null;
	}
	const node = await getNode(core.db, row.node_id);
	const link = core.links.get(row.node_id);
	if (!node || !link || link.conn.closed || !link.ready || !link.trustFresh) return null;
	const report = parseTrustReport(node.trust_report);
	if (report?.kind !== "ok") return null;
	const judged = await judgeOwnerAuthorization(core, {
		payload,
		payloadBytes: submitted.payloadBytes,
		signatures: submitted.signatures,
		summary: report.summary,
		nodeId: node.id,
		task: { id, attempt: row.attempt, spec: specFromRow(row.spec, "task") },
		material,
	});
	if (!judged.accepted) return null;
	return { row, node, link, signatures: judged.signatures, cosigned: judged.cosigned };
}

async function insertOwnerAuthorization(
	core: ClusterCore,
	user: SessionUser,
	submitted: SubmittedAuthorization,
): Promise<boolean> {
	const existing = await core.db
		.selectFrom("authorizations")
		.select("id")
		.where("id", "=", submitted.id)
		.executeTakeFirst();
	if (existing) return false;
	await core.db
		.insertInto("authorizations")
		.values({
			id: submitted.id,
			org_id: await defaultOrgId(core.db),
			payload: Buffer.from(submitted.payloadBytes).toString("base64"),
			signatures: signaturesToJson(submitted.signatures),
			issuer_user_id: user.userId,
			task_ids: submitted.payload.taskIds === null ? null : JSON.stringify(submitted.payload.taskIds),
			deadline: submitted.payload.deadlineMs === null ? null : new Date(submitted.payload.deadlineMs).toISOString(),
			created_at: now(),
			revoked_at: null,
		})
		.execute();
	return true;
}

async function storeCosignatures(
	core: ClusterCore,
	submitted: SubmittedAuthorization,
	cosignatures: Signature[],
): Promise<void> {
	const row = await core.db
		.selectFrom("authorizations")
		.select(["signatures", "revoked_at"])
		.where("id", "=", submitted.id)
		.executeTakeFirst();
	if (!row || row.revoked_at !== null) return;
	const stored = signaturesFromJson(row.signatures);
	const keys = new Set(stored.map(signatureKey));
	const combined = [...stored];
	for (const signature of cosignatures) {
		const key = signatureKey(signature);
		if (keys.has(key)) continue;
		keys.add(key);
		combined.push(signature);
	}
	await core.db
		.updateTable("authorizations")
		.set({ signatures: signaturesToJson(combined) })
		.where("id", "=", submitted.id)
		.execute();
}

async function isRevoked(core: ClusterCore, id: string): Promise<boolean> {
	const row = await core.db.selectFrom("authorizations").select("revoked_at").where("id", "=", id).executeTakeFirst();
	return row?.revoked_at != null;
}

// ---- sending the authorized start ----

/** Signs the planned payload with crhs's key, stores it and sends it inside task.start. */
async function dispatchCrhs(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	node: NodeRow,
	link: NodeLink,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	opts: { timeoutMs?: number },
	record: TaskAuthorizationRecord,
	authorization: BuiltAuthorization,
	from: readonly TaskRowState[],
): Promise<void> {
	const key = core.authorizationKey;
	if (!key) {
		await finishAuthorization(
			core,
			id,
			row,
			"rejected",
			"authorization_required",
			"crhs has no authorization signing key",
			record,
		);
		return;
	}
	let encoded: Uint8Array;
	let signatures: Signature[];
	try {
		signatures = [{ kind: "sshsig", blob: key.sign(authorization.bytes) }];
		const wire: Authorization = { payload: authorization.bytes, signatures };
		encoded = encodeCbor(authorizationCodec.encode(wire));
	} catch (err) {
		await finishAuthorization(
			core,
			id,
			row,
			"failed",
			"invalid_spec",
			`cannot encode the authorization: ${errorText(err)}`,
			record,
		);
		return;
	}
	// An authorization may take at most half a frame so the rest of task.start still fits (doc/protocol.md#授权对象).
	if (encoded.length > MAX_FRAME_BYTES / 2) {
		await finishAuthorization(
			core,
			id,
			row,
			"failed",
			"invalid_spec",
			`the authorization is ${encoded.length} bytes, more than half a frame`,
			record,
		);
		return;
	}
	if (await storeAuthorization(core, node, authorization, signatures)) {
		// crhs-signed authorizations are audited like user ones (doc/access-control.md#记录内容).
		core.auditLater({
			actor: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
			action: "authorization.issued",
			target: { type: "authorization", id: authorization.id },
			detail: {
				node_id: node.id,
				task_id: id,
				attempt: row.attempt,
				deadline:
					authorization.payload.deadlineMs === null ? null : new Date(authorization.payload.deadlineMs).toISOString(),
				trust_digest: record.trustDigest,
			},
		});
	}
	const updated: TaskAuthorizationRecord = {
		...record,
		dispatchedPath: "crhs",
		payloadId: authorization.id,
		attempt: row.attempt,
		pending: null,
		local: null,
		updatedAt: new Date().toISOString(),
	};
	withdrawLocal(link, id, record);
	const claimed = await updateTask(core, id, from, {
		state: "dispatched",
		dispatched_at: now(),
		authorization: serializeTaskAuthorization(updated),
		pending_input: null,
		handler_type: null,
		handler_session_id: null,
	});
	if (!claimed) return;
	newLive(core, id, node.id, row.output_mode, row.task_group_id);
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	const start = taskStartOf(id, row, spec, {
		privileged: true,
		attempt: row.attempt,
		authorizations: [encoded],
		timeoutMs: opts.timeoutMs ?? row.timeout_ms ?? 0,
	});
	await sendAuthorizedStart(core, link, node.id, id, spec, inputBytes, start, updated);
}

/**
 * Sends an authorized task.start and follows up: accepted, terminal failure, or a retryable
 * authorization rejection that re-plans with `attempt + 1` (doc/execution-plane.md#不重复执行与授权重试).
 */
async function sendAuthorizedStart(
	core: ClusterCore,
	link: NodeLink,
	nodeId: string,
	id: string,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	start: ReturnType<typeof taskStartOf>,
	record: TaskAuthorizationRecord,
): Promise<void> {
	try {
		await link.conn.peer.request("task.start", start);
	} catch (err) {
		if (err instanceof ConnectionError) {
			// The task stays dispatched; the grace timer reports dispatch_unconfirmed, never a retry.
			return;
		}
		if (err instanceof RemoteError && AUTHORIZATION_CODES.has(err.code)) {
			await retryAuthorization(core, link, id, spec, inputBytes, record, err.code, err.message);
			return;
		}
		if (err instanceof RemoteError) {
			await finish(core, nodeId, id, { state: "failed", error_code: err.code, error_message: err.message });
			return;
		}
		if (err instanceof ProtocolError) {
			// Raised locally while encoding: the request was never sent, so nothing can have run.
			await finish(core, nodeId, id, { state: "failed", error_code: "invalid_spec", error_message: err.message });
			return;
		}
		console.error("task.start failed:", err);
		link.conn.close("send failed");
		return;
	}
	await onAccepted(core, nodeId, id);
	for (let off = 0; off < inputBytes.length; off += core.chunkBytes) {
		const data = inputBytes.subarray(off, off + core.chunkBytes);
		void link.conn.peer
			.request("task.input", { taskId: id, offset: off, data })
			.catch((err: unknown) => console.error(`task.input for ${id} failed:`, err));
	}
}

/**
 * A crha rejected the authorization before accepting, so nothing ran: the path that was sent is
 * ruled out, the attempt advances and the plan is recomputed from the refreshed trust summary.
 */
async function retryAuthorization(
	core: ClusterCore,
	link: NodeLink,
	id: string,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	record: TaskAuthorizationRecord,
	code: string,
	message: string,
): Promise<void> {
	// crha refreshes its trust summary before sending an authorization_* error on the same connection, and the
	// summaries that arrived before this call must be stored before the plan is recomputed (doc/protocol.md#taskstart).
	await core.trustQueue.tail(link.conn.nodeId);
	const row = await core.row(id);
	if (row?.state !== "dispatched") return; // accepted (or ended) meanwhile: never retried
	const attempt = row.attempt + 1;
	// Only crhs's own signature path is ruled out for good (D83): the owner may sign again for the
	// new attempt, and so may a local approver.
	const tried =
		record.dispatchedPath === "crhs" ? [...new Set<AuthorizationPath>([...record.tried, "crhs"])] : record.tried;
	const updated: TaskAuthorizationRecord = {
		...record,
		tried,
		attempt,
		pending: null,
		local: null,
		lastRejection: { code, message, attempt: row.attempt, at: new Date().toISOString() },
		updatedAt: new Date().toISOString(),
	};
	withdrawLocal(link, id, record);
	const res = await core.db
		.updateTable("tasks")
		.set({
			state: "awaiting_authorization",
			attempt,
			authorization: serializeTaskAuthorization(updated),
			pending_input: inputBytes.length > 0 ? Buffer.from(inputBytes).toString("base64") : null,
			dispatched_at: null,
			handler_type: "user",
			handler_session_id: null,
		})
		.where("id", "=", id)
		.where("state", "=", "dispatched")
		.executeTakeFirst();
	if (res.numUpdatedRows === 0n) return;
	dropLive(core, id);
	core.notify(id);
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	// The task waits for a signature again; the session is awaiting it (doc/agent-runtime.md#会话状态).
	core.onChange?.(row.actor_id);
	const node = await getNode(core.db, row.node_id);
	const current = core.links.get(row.node_id);
	if (!node || !current || current.conn.closed || !current.ready) return;
	await planPrivileged(core, id, node, current, spec, inputBytes, { timeoutMs: row.timeout_ms ?? undefined }, [
		"awaiting_authorization",
	]);
}

/** Ends a task that could not be authorized, with the plan and the reason on its record. */
async function finishAuthorization(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	state: "failed" | "rejected",
	code: string,
	message: string,
	record: TaskAuthorizationRecord | null,
): Promise<void> {
	// Withdraw first, even when the row turns out settled: another path may have claimed the task
	// while its request was still outstanding on the node (doc/privilege.md#本地批准).
	withdrawLocal(core.links.get(row.node_id), id, record);
	await endTask(core, id, {
		write: {
			from: [row.state],
			set: {
				state,
				error_code: code,
				error_message: message,
				...(record ? { authorization: serializeTaskAuthorization(record) } : {}),
				pending_input: null,
				dispatched_at: null,
				handler_type: null,
				handler_session_id: null,
			},
		},
		live: "drop",
		group: row.task_group_id,
		onChange: row.actor_id,
	});
}

/**
 * Stores the signed payload, verbatim, for display, lookup and revocation (doc/m4.md#crhs-侧数据).
 * Returns whether this call inserted it (an id already present is left alone).
 */
async function storeAuthorization(
	core: ClusterCore,
	node: NodeRow,
	authorization: BuiltAuthorization,
	signatures: readonly Signature[],
): Promise<boolean> {
	const existing = await core.db
		.selectFrom("authorizations")
		.select("id")
		.where("id", "=", authorization.id)
		.executeTakeFirst();
	if (existing) return false;
	const { deadlineMs, taskIds } = authorization.payload;
	await core.db
		.insertInto("authorizations")
		.values({
			id: authorization.id,
			org_id: node.org_id,
			payload: Buffer.from(authorization.bytes).toString("base64"),
			signatures: JSON.stringify(signatures.map(signatureToJson)),
			issuer_user_id: null,
			task_ids: taskIds === null ? null : JSON.stringify(taskIds),
			deadline: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
			created_at: now(),
			revoked_at: null,
		})
		.execute();
	return true;
}

// ---- the tasks that wait for a signature ----

/**
 * Dispatches a waiting task with an authorization the owner already stored (submitted while the node
 * was offline, or a reusable one): the same reuse lookup the planner does, without re-planning the
 * payload, so a signature survives a reconnect.
 */
export async function useStoredAuthorizations(core: ClusterCore, nodeId: string): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("node_id", "=", nodeId)
		.where("state", "=", "awaiting_authorization")
		.execute();
	for (const { id } of rows) await core.taskQueue.run(id, () => dispatchStored(core, id));
}

async function dispatchStored(core: ClusterCore, id: string): Promise<void> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return;
	const node = await getNode(core.db, row.node_id);
	const link = core.links.get(row.node_id);
	if (!node || !link || link.conn.closed || !link.ready || !link.trustFresh) return;
	const report = parseTrustReport(node.trust_report);
	if (report?.kind !== "ok") return;
	const previous = parseTaskAuthorization(row.authorization);
	const skip = new Set<string>();
	if (previous?.lastRejection && previous.payloadId) skip.add(previous.payloadId);
	const reusable = await findReusableAuthorization(
		core,
		row,
		node,
		report.summary,
		specFromRow(row.spec, "task"),
		skip,
	);
	if (!reusable) return;
	await dispatchOwnerAuthorization(core, row, node, link, reusable.submitted, reusable.cosigned);
}

/** Re-plans the node's tasks that wait for an authorization signature after its trust digest changed. */
export async function replanAwaiting(core: ClusterCore, nodeId: string): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("node_id", "=", nodeId)
		.where("state", "=", "awaiting_authorization")
		.execute();
	for (const { id } of rows) await core.taskQueue.run(id, () => replan(core, id));
}

async function replan(core: ClusterCore, id: string): Promise<void> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return;
	const node = await getNode(core.db, row.node_id);
	const link = core.links.get(row.node_id);
	if (!node || !link || link.conn.closed || !link.ready) return;
	const spec = specFromRow(row.spec, "task");
	const input = row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
	await planPrivileged(core, id, node, link, spec, input, { timeoutMs: row.timeout_ms ?? undefined }, [
		"awaiting_authorization",
	]);
}

/**
 * Ends the tasks whose signature has not arrived within AUTHORIZATION_WAIT_MS since they began to wait
 * (doc/privilege.md#等待签名的期限): from the approval decision when there was one, else from creation.
 * Run at startup and by the periodic sweep; returns how many tasks it ended.
 */
export async function expireAuthorizationWaits(core: ClusterCore, nowMs: number = Date.now()): Promise<number> {
	const rows = await core.db.selectFrom("tasks").selectAll().where("state", "=", "awaiting_authorization").execute();
	let ended = 0;
	for (const row of rows) {
		if (nowMs - authorizationWaitStart(row) < AUTHORIZATION_WAIT_MS) continue;
		const before = await core.row(row.id);
		if (before?.state !== "awaiting_authorization") continue;
		await finishAuthorization(
			core,
			row.id,
			before,
			"rejected",
			"authorization_wait_expired",
			`no signature arrived within ${AUTHORIZATION_WAIT_MS / 3_600_000} hours`,
			parseTaskAuthorization(before.authorization),
		);
		ended++;
	}
	return ended;
}

/** When a task began to wait for its signature: its approval decision when it had one, else its creation. */
function authorizationWaitStart(row: Selectable<TasksTable>): number {
	const created = Date.parse(row.created_at);
	if (!row.approval) return created;
	try {
		const decidedAt = (JSON.parse(row.approval) as ApprovalRecord).decision?.at;
		const decided = decidedAt ? Date.parse(decidedAt) : Number.NaN;
		return Number.isNaN(decided) ? created : Math.max(created, decided);
	} catch {
		return created;
	}
}

// ---- helpers ----

/** The payload the owner signs, in the form stored on the task and shown by the API. */
function pendingOf(authorization: BuiltAuthorization): PendingPayloadView {
	return {
		payload: Buffer.from(authorization.bytes).toString("base64"),
		id: authorization.id,
		deadline:
			authorization.payload.deadlineMs === null ? null : new Date(authorization.payload.deadlineMs).toISOString(),
		taskIds: authorization.payload.taskIds ?? [],
		attempt: authorization.payload.attempt ?? 0,
	};
}

/** The lifetime of the user path of a stored plan; the default when the plan has none. */
function userPathTtl(record: TaskAuthorizationRecord | null): number {
	const path = record?.plan.paths.find((candidate) => candidate.path === "user");
	return path?.ttlMs ?? USER_AUTHORIZATION_TTL_MS;
}

/** The decision port (`authz.ts`) fed with an owner authorization and a node's trust summary. */
function decideOwnerAuthorization(input: {
	now: number;
	summary: TrustSummary;
	nodeId: string;
	task: { id: string; attempt: number; spec: TaskSpec };
	payload: AuthorizationPayload;
	payloadBytes: Uint8Array;
	signatures: readonly AuthzSignature[];
}): AuthzDecision {
	return decide({
		now: input.now,
		clockSkewMs: input.summary.clockSkewMs,
		nodeId: input.nodeId,
		nodeGroups: input.summary.groups,
		trust: input.summary.trust.map(authzEntryFromTrust),
		task: input.task,
		authorization: { payload: input.payloadBytes, decoded: input.payload, signatures: input.signatures },
		localApproval: null,
	});
}

/** An authorization command with its byte hash as hex, for the audit detail. */
function commandForAudit(command: AuthorizationPayload["command"]): Record<string, unknown> | null {
	if (command === null) return null;
	return command.match.kind === "exact"
		? {
				method: command.method,
				match: "exact",
				target: command.match.target,
				spec_sha256: Buffer.from(command.match.specSha256).toString("hex"),
			}
		: { method: command.method, match: "prefix", target: command.match.target };
}

/** Content identity of a signature, so a stored cosignature is not appended twice. */
function signatureKey(signature: Signature): string {
	return signaturesToJson([signature]);
}

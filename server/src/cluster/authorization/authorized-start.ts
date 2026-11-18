/**
 * Sending an authorized task.start (doc/design/execution.md "No duplicate execution and authorization retry"): crhs's own signature,
 * the last checks before the frame leaves, and the retry with a higher attempt after the node rejected
 * the authorization.
 */

import {
	type Authorization,
	authorizationCodec,
	encode as encodeCbor,
	MAX_FRAME_BYTES,
	type Signature,
	type TaskSpec,
	type TaskStart,
} from "@crh/protocol";
import type { Selectable } from "kysely";
import { authorizationDeadline, type BuiltAuthorization } from "../../privilege/payload.ts";
import { windowIdentity } from "../../privilege/planner.ts";
import type { TasksTable } from "../../storage/schema.ts";
import { errorText } from "../../util/errors.ts";
import {
	parseTaskAuthorization,
	serializeTaskAuthorization,
	signatureToJson,
	type TaskAuthorizationRecord,
} from "../authorization.ts";
import { type ClusterCore, now } from "../core.ts";
import type { NodeLink } from "../links.ts";
import { dropLive, newLive } from "../live-output.ts";
import { userCanAccessNode } from "../node-access.ts";
import type { NodeRow } from "../nodes.ts";
import { getNode } from "../nodes.ts";
import { specFromRow } from "../spec.ts";
import {
	endIfNodeUnready,
	failNodeOffline,
	finish,
	groupEnded,
	NODE_ACCESS_REVOKED,
	NODE_ACCESS_REVOKED_MESSAGE,
	syncGroupState,
	updateTask,
} from "../task-end.ts";
import { writeTask } from "../task-rows.ts";
import { pendingInputColumn, pendingInputOf, sendTaskStart, taskStartOf } from "../task-start.ts";
import { parseTrustReport } from "../trust.ts";
import { type AuthorizedStart, emptyAuthorizationRecord, finishAuthorization, withoutOptions } from "./common.ts";

export type { AuthorizedStart };

/**
 * Claims a waiting task for crhs's own signature: signs and encodes the payload, stores it and writes the
 * rev-guarded claim. Runs in the task's turn on the row the sync pass planned from. The task.start is NOT
 * sent here: it waits for the node's answer, so the pass sends it outside the turn. Returns what to send,
 * or null when the task was not claimed (it was ended here, or it changed and the next pass plans it).
 */
export async function claimCrhs(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	node: NodeRow,
	authorization: BuiltAuthorization,
	keyFingerprint: string,
): Promise<AuthorizedStart | null> {
	const id = row.id;
	const record = parseTaskAuthorization(row.authorization) ?? emptyAuthorizationRecord(row.attempt);
	// The payload names the attempt the pass read; a row at another attempt is not this plan's row.
	if (authorization.payload.attempt !== row.attempt) return null;
	// A member of a group that already ended never dispatches again.
	if (await groupEnded(core, row.task_group_id)) return null;
	let spec: TaskSpec;
	try {
		spec = specFromRow(row.spec, "task");
	} catch (err) {
		await finishAuthorization(
			core,
			id,
			row,
			"errored",
			"invalid_spec",
			`the stored spec cannot be read: ${errorText(err)}`,
			record,
		);
		return null;
	}
	// The plan chose the newest key this node trusts (with `execute`, or any kind while a local
	// window is open); it may have been deleted since.
	const key = core.signingKeys.byFingerprint(keyFingerprint);
	if (!key) {
		await finishAuthorization(
			core,
			id,
			row,
			"rejected",
			"authorization_required",
			"crhs has no authorization signing key for this node",
			record,
		);
		return null;
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
			"errored",
			"invalid_spec",
			`cannot encode the authorization: ${errorText(err)}`,
			record,
		);
		return null;
	}
	// An authorization may take at most half a frame so the rest of task.start still fits (doc/design/protocol.md "Authorization object").
	if (encoded.length > MAX_FRAME_BYTES / 2) {
		await finishAuthorization(
			core,
			id,
			row,
			"errored",
			"invalid_spec",
			`the authorization is ${encoded.length} bytes, more than half a frame`,
			record,
		);
		return null;
	}
	// The row is stored before the claim: the task's record names its payload id, and a claim that loses a
	// race leaves the payload behind for an audit trail, even though no task.start is sent.
	const stored = await storeAuthorization(core, node, authorization, signatures);
	const updated: TaskAuthorizationRecord = {
		...withoutOptions(record),
		dispatchedPath: "crhs",
		payloadId: authorization.id,
		attempt: row.attempt,
		trustDigest: node.trust_digest,
	};
	const input = pendingInputOf(row);
	const claimed = await updateTask(
		core,
		id,
		["awaiting_authorization"],
		{
			state: "dispatched",
			dispatched_at: now(),
			authorization: serializeTaskAuthorization(updated),
			pending_input: null,
			handler_type: null,
			handler_session_id: null,
		},
		row.rev,
	);
	if (!claimed) return null;
	// crhs-signed authorizations are audited like user ones, but only once their task.start will be sent: a
	// cancelled task must not leave an authorization.issued event for a payload the node never received
	// (doc/design/access-control.md "Recorded events").
	if (stored) {
		core.auditLater({
			actor: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
			action: "authorization.issued",
			target: { type: "authorization", id: authorization.id },
			detail: {
				node_id: node.id,
				task_id: id,
				attempt: row.attempt,
				deadline: authorizationDeadline(authorization.payload.deadlineMs),
				trust_digest: node.trust_digest,
			},
		});
	}
	newLive(core, id, node.id, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes);
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	// The task no longer waits; the session it belongs to runs again (doc/design/agent-runtime.md "Session state").
	core.onChange?.(row.actor_id);
	const start = taskStartOf(id, row, spec, {
		privileged: true,
		attempt: row.attempt,
		authorizations: [encoded],
		timeoutMs: row.timeout_ms ?? 0,
	});
	return { nodeId: node.id, start, input, record: updated };
}

/**
 * Sends an authorized task.start and follows up: accepted, terminal failure, or a retryable
 * authorization rejection that makes the task wait again at `attempt + 1` and asks for a sync (`resync`) (doc/design/execution.md "No duplicate execution and authorization retry").
 * The task is already claimed (`dispatched`); the node's current link is looked up here. Always called
 * outside a task turn: the readiness wait is outside, the writes that settle the task are one
 * turn each, in the task's queue.
 */
export async function sendAuthorizedStart(
	core: ClusterCore,
	nodeId: string,
	start: TaskStart,
	inputBytes: Uint8Array,
	record: TaskAuthorizationRecord,
	resync: () => void,
): Promise<void> {
	const id = start.taskId;
	// Last check before the frame leaves: never send for a user who has lost access in the meantime.
	const revoked = await core.taskQueue.run(id, async () => {
		const current = await core.row(id);
		if (current && !(await userCanAccessNode(core.db, current.on_behalf_of_user_id, nodeId))) {
			await finish(core, nodeId, id, {
				state: "errored",
				error_code: NODE_ACCESS_REVOKED,
				error_message: NODE_ACCESS_REVOKED_MESSAGE,
				pending_input: null,
				handler_type: null,
				handler_session_id: null,
			});
			return true;
		}
		return false;
	});
	if (revoked) return;
	// The task is claimed for dispatch but the frame has not left yet; if the link dropped in
	// between, the node still gets the grace to come back before the send fails. Whether its trust
	// report is from this connection does not matter: crha decides, and a refusal is retried below.
	const ready = await core.readyNode(nodeId);
	if (!ready?.link) {
		// Nothing was sent. A cancellation recorded in the meantime already ended the row as cancelled,
		// so the offline ending, guarded on the live states, is a no-op for it.
		await endIfNodeUnready(core, id, ready, async () => {
			await failNodeOffline(core, id, {
				from: ["dispatched", "running"],
				nodeId,
				live: "drop",
				always: true,
				group: "row",
				awaitGroup: true,
			});
		});
		return;
	}
	const link = ready.link;
	// No write happens inside sendTaskStart without the task's queue: every answer is settled in a turn.
	await sendTaskStart(core, link, nodeId, start, inputBytes, {
		settle: (write) => core.taskQueue.run(id, write),
		onAuthorizationRejected: (err) =>
			retryAuthorization(core, link, id, inputBytes, record, err.code, err.message, resync),
	});
}

/**
 * A crha rejected the authorization before accepting, so nothing ran. The task waits again at the next
 * attempt with what the rejection rules out recorded (doc/design/privilege.md "Authorization path"):
 * crhs's own signature under the node's current local window, or every owner authorization stored up
 * to the one that was sent. The read and the rev-guarded write are one turn; the unit's sync is only
 * requested.
 */
async function retryAuthorization(
	core: ClusterCore,
	link: NodeLink,
	id: string,
	inputBytes: Uint8Array,
	record: TaskAuthorizationRecord,
	code: string,
	message: string,
	resync: () => void,
): Promise<void> {
	// crha refreshes its trust summary before sending an authorization_* error on the same connection, and the
	// summaries that arrived before this call must be stored before the unit is planned again (doc/design/privilege.md "Trust cache").
	// The tail is awaited outside the task turn: the trust work it waits for may need a task turn of its own.
	await core.trustQueue.tail(link.conn.nodeId);
	const ruledOut = await ruledOutBy(core, link.conn.nodeId, record);
	const row = await core.taskQueue.run(id, async (): Promise<Selectable<TasksTable> | null> => {
		const current = await core.row(id);
		if (current?.state !== "dispatched") return null; // accepted (or ended) meanwhile: never retried
		const attempt = current.attempt + 1;
		const updated: TaskAuthorizationRecord = {
			...withoutOptions(record),
			...ruledOut,
			// Nothing is in flight any more; `payloadId` keeps naming what was refused.
			dispatchedPath: null,
			attempt,
			lastRejection: { code, message, attempt: current.attempt, at: new Date().toISOString() },
		};
		const returned = await writeTask(
			core.db,
			id,
			{ states: ["dispatched"], rev: current.rev },
			{
				state: "awaiting_authorization",
				attempt,
				authorization: serializeTaskAuthorization(updated),
				pending_input: pendingInputColumn(inputBytes),
				dispatched_at: null,
				handler_type: "user",
				handler_session_id: null,
			},
		);
		if (!returned) return null;
		dropLive(core, id);
		core.notify(id);
		core.background("task group state update failed", syncGroupState(core, current.task_group_id));
		// The task waits again; the session is awaiting it (doc/design/agent-runtime.md "Session state").
		core.onChange?.(current.actor_id);
		return current;
	});
	if (row) resync();
}

/**
 * What a rejection of the path that was sent rules out: crhs's signature while the node keeps the same
 * local window (identified by its `openedAtMs`, never compared as a time), or the owner authorizations
 * stored no later than the rejected one.
 */
async function ruledOutBy(
	core: ClusterCore,
	nodeId: string,
	record: TaskAuthorizationRecord,
): Promise<Pick<TaskAuthorizationRecord, "crhsRejected" | "rejectedBefore">> {
	if (record.dispatchedPath === "crhs") {
		const node = await getNode(core.db, nodeId);
		const report = node ? parseTrustReport(node.trust_report) : null;
		return {
			crhsRejected: { window: report?.kind === "ok" ? windowIdentity(report.summary) : null },
			rejectedBefore: record.rejectedBefore,
		};
	}
	if (record.dispatchedPath === "user" && record.payloadId !== null) {
		const sent = await core.db
			.selectFrom("authorizations")
			.select("created_at")
			.where("id", "=", record.payloadId)
			.executeTakeFirst();
		if (sent) {
			const before =
				record.rejectedBefore && record.rejectedBefore > sent.created_at ? record.rejectedBefore : sent.created_at;
			return { crhsRejected: record.crhsRejected, rejectedBefore: before };
		}
	}
	return { crhsRejected: record.crhsRejected, rejectedBefore: record.rejectedBefore };
}

/**
 * Stores the signed payload, verbatim, for display and lookup (doc/design/privilege.md "Server-side authorization").
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
			deadline: authorizationDeadline(deadlineMs),
			created_at: now(),
		})
		.execute();
	return true;
}

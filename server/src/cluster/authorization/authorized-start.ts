/**
 * Sending an authorized task.start (doc/execution-plane.md#不重复执行与授权重试): crhs's own signature,
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
import type { BuiltAuthorization } from "../../privilege/payload.ts";
import type { AuthorizationPath } from "../../privilege/planner.ts";
import type { TaskState as TaskRowState, TasksTable } from "../../storage/schema.ts";
import { errorText } from "../../util/errors.ts";
import { serializeTaskAuthorization, signatureToJson, type TaskAuthorizationRecord } from "../authorization.ts";
import { type ClusterCore, now } from "../core.ts";
import type { NodeLink } from "../links.ts";
import { dropLive, newLive } from "../live-output.ts";
import { userCanAccessNode } from "../node-access.ts";
import type { NodeRow } from "../nodes.ts";
import { getNode } from "../nodes.ts";
import {
	cancelledTaskFields,
	finish,
	NODE_ACCESS_REVOKED,
	NODE_ACCESS_REVOKED_MESSAGE,
	syncGroupState,
	updateTask,
} from "../task-end.ts";
import { writeTask } from "../task-rows.ts";
import { pendingInputColumn, sendTaskStart, taskStartOf } from "../task-start.ts";
import { finishAuthorization, withdrawLocal, withoutRequests } from "./common.ts";
import { replanWaiting } from "./plan.ts";

/** A claimed privileged task whose task.start may now be sent, outside the turn that claimed it (D118). */
export interface AuthorizedStart {
	nodeId: string;
	start: TaskStart;
	input: Uint8Array;
	record: TaskAuthorizationRecord;
}

/**
 * Claims the task for crhs's own signature: signs and encodes the payload, stores it, withdraws a local
 * request, and writes the rev-guarded claim. The task.start is NOT sent here: it waits for the node's
 * answer, so its caller sends it outside the turn (D118). Returns what to send, or null when the claim
 * lost (the task then dispatches from no path).
 */
export async function claimCrhs(
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
): Promise<AuthorizedStart | null> {
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
			"failed",
			"invalid_spec",
			`cannot encode the authorization: ${errorText(err)}`,
			record,
		);
		return null;
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
		return null;
	}
	// The row is stored before the claim: the task's record names its payload id, and a claim that loses a
	// race leaves the payload behind for an audit trail, even though no task.start is sent.
	const stored = await storeAuthorization(core, node, authorization, signatures);
	const updated: TaskAuthorizationRecord = {
		...withoutRequests(record),
		dispatchedPath: "crhs",
		payloadId: authorization.id,
		attempt: row.attempt,
	};
	withdrawLocal(link, id, record);
	const claimed = await updateTask(
		core,
		id,
		from,
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
	// (doc/access-control.md#记录内容).
	if (stored) {
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
	newLive(core, id, node.id, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes);
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	const start = taskStartOf(id, row, spec, {
		privileged: true,
		attempt: row.attempt,
		authorizations: [encoded],
		timeoutMs: opts.timeoutMs ?? row.timeout_ms ?? 0,
	});
	return { nodeId: node.id, start, input: inputBytes, record: updated };
}

/**
 * Claims and sends with crhs's own signature in one call, for callers outside a turn. claimCrhs() is the
 * turn body (planPrivileged calls it inside its plan turn); the send is outside it. The row the caller
 * read is not trusted: the claim re-reads it in the turn, so a stale caller row cannot write itself back.
 */
export async function dispatchCrhs(
	core: ClusterCore,
	id: string,
	_row: Selectable<TasksTable>,
	node: NodeRow,
	link: NodeLink,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	opts: { timeoutMs?: number },
	record: TaskAuthorizationRecord,
	authorization: BuiltAuthorization,
	from: readonly TaskRowState[],
): Promise<void> {
	const claim = await core.taskQueue.run(id, async () => {
		const fresh = await core.row(id);
		if (!fresh) return null;
		return claimCrhs(core, id, fresh, node, link, spec, inputBytes, opts, record, authorization, from);
	});
	if (claim) await sendAuthorizedStart(core, claim.nodeId, claim.start, claim.input, claim.record);
}

/**
 * Sends an authorized task.start and follows up: accepted, terminal failure, or a retryable
 * authorization rejection that re-plans with `attempt + 1` (doc/execution-plane.md#不重复执行与授权重试).
 * The task is already claimed (`dispatched`); the node's current link is looked up here. Always called
 * outside a task turn (D118): the readiness wait is outside, the writes that settle the task are one
 * turn each, in the task's queue.
 */
export async function sendAuthorizedStart(
	core: ClusterCore,
	nodeId: string,
	start: TaskStart,
	inputBytes: Uint8Array,
	record: TaskAuthorizationRecord,
): Promise<void> {
	const id = start.taskId;
	// Last check before the frame leaves: never send for a user who has lost access in the meantime (D108).
	const revoked = await core.taskQueue.run(id, async () => {
		const current = await core.row(id);
		if (current && !(await userCanAccessNode(core.db, current.on_behalf_of_user_id, nodeId))) {
			await finish(core, nodeId, id, {
				state: "failed",
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
	// D113: the task is claimed for dispatch but the frame has not left yet; if the link dropped in
	// between, the node still gets the grace to come back before the send fails.
	const node = await getNode(core.db, nodeId);
	const ready = await core.readyNode(nodeId, { trust: node?.privileged_mode === "forward" });
	if (!ready?.link) {
		// Nothing was sent: a cancellation recorded in the meantime ends the task as cancelled, not offline.
		await core.taskQueue.run(id, async () => {
			const current = await core.row(id);
			if (current?.cancelled === 1) {
				await finish(core, nodeId, id, cancelledTaskFields());
				return;
			}
			await finish(core, nodeId, id, {
				state: "failed",
				error_code: "node_offline",
				error_message: "the node is not connected",
				pending_input: null,
				handler_type: null,
				handler_session_id: null,
			});
		});
		return;
	}
	const link = ready.link;
	// No write happens inside sendTaskStart without the task's queue: every answer is settled in a turn.
	await sendTaskStart(core, link, nodeId, start, inputBytes, {
		settle: (write) => core.taskQueue.run(id, write),
		onAuthorizationRejected: (err) =>
			retryAuthorization(core, link, id, start.spec, inputBytes, record, err.code, err.message),
	});
}

/**
 * A crha rejected the authorization before accepting, so nothing ran: the path that was sent is
 * ruled out, the attempt advances and the plan is recomputed from the refreshed trust summary. The read
 * and the rev-guarded write are one turn; the re-plan (which waits for trust outside its own turns)
 * runs after it.
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
	// The tail is awaited outside the task turn: the trust work it waits for may need a task turn of its own.
	await core.trustQueue.tail(link.conn.nodeId);
	const row = await core.taskQueue.run(id, async (): Promise<Selectable<TasksTable> | null> => {
		const current = await core.row(id);
		if (current?.state !== "dispatched") return null; // accepted (or ended) meanwhile: never retried
		// A cancel arrived while the task.start was on its way: the task must not go back to waiting.
		if (current.cancelled === 1) {
			await finish(core, link.conn.nodeId, id, cancelledTaskFields());
			return null;
		}
		const attempt = current.attempt + 1;
		// Only crhs's own signature path is ruled out for good (D83): the owner may sign again for the
		// new attempt, and so may a local approver.
		const tried =
			record.dispatchedPath === "crhs" ? [...new Set<AuthorizationPath>([...record.tried, "crhs"])] : record.tried;
		const updated: TaskAuthorizationRecord = {
			...withoutRequests(record),
			tried,
			attempt,
			lastRejection: { code, message, attempt: current.attempt, at: new Date().toISOString() },
		};
		withdrawLocal(link, id, record);
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
		// The task waits for a signature again; the session is awaiting it (doc/agent-runtime.md#会话状态).
		core.onChange?.(current.actor_id);
		return current;
	});
	if (row) await replanWaiting(core, id, row, { spec, input: inputBytes });
}

/**
 * Stores the signed payload, verbatim, for display and lookup (doc/m4.md#crhs-侧数据).
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
		})
		.execute();
	return true;
}

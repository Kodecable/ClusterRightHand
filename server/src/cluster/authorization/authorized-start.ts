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
import { finish, NODE_ACCESS_REVOKED, NODE_ACCESS_REVOKED_MESSAGE, syncGroupState, updateTask } from "../task-end.ts";
import { pendingInputColumn, sendTaskStart, taskStartOf } from "../task-start.ts";
import { finishAuthorization, withdrawLocal, withoutRequests } from "./common.ts";
import { replanWaiting } from "./plan.ts";

/** Signs the planned payload with crhs's key, stores it and sends it inside task.start. */
export async function dispatchCrhs(
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
		...withoutRequests(record),
		dispatchedPath: "crhs",
		payloadId: authorization.id,
		attempt: row.attempt,
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
	newLive(core, id, node.id, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes);
	core.background("task group state update failed", syncGroupState(core, row.task_group_id));
	const start = taskStartOf(id, row, spec, {
		privileged: true,
		attempt: row.attempt,
		authorizations: [encoded],
		timeoutMs: opts.timeoutMs ?? row.timeout_ms ?? 0,
	});
	await sendAuthorizedStart(core, node.id, start, inputBytes, updated);
}

/**
 * Sends an authorized task.start and follows up: accepted, terminal failure, or a retryable
 * authorization rejection that re-plans with `attempt + 1` (doc/execution-plane.md#不重复执行与授权重试).
 * The task is already claimed (`dispatched`); the node's current link is looked up here.
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
		return;
	}
	// D113: the task is claimed for dispatch but the frame has not left yet; if the link dropped in
	// between, the node still gets the grace to come back before the send fails.
	const node = await getNode(core.db, nodeId);
	const ready = await core.readyNode(nodeId, { trust: node?.privileged_mode === "forward" });
	if (!ready?.link) {
		await finish(core, nodeId, id, {
			state: "failed",
			error_code: "node_offline",
			error_message: "the node is not connected",
			pending_input: null,
			handler_type: null,
			handler_session_id: null,
		});
		return;
	}
	const link = ready.link;
	// The authorized path runs on its caller's queue (or none): its writes are not queued again here.
	await sendTaskStart(core, link, nodeId, start, inputBytes, {
		settle: (write) => write(),
		onAuthorizationRejected: (err) =>
			retryAuthorization(core, link, id, start.spec, inputBytes, record, err.code, err.message),
	});
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
		...withoutRequests(record),
		tried,
		attempt,
		lastRejection: { code, message, attempt: row.attempt, at: new Date().toISOString() },
	};
	withdrawLocal(link, id, record);
	const res = await core.db
		.updateTable("tasks")
		.set({
			state: "awaiting_authorization",
			attempt,
			authorization: serializeTaskAuthorization(updated),
			pending_input: pendingInputColumn(inputBytes),
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
	await replanWaiting(core, id, row, { spec, input: inputBytes });
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

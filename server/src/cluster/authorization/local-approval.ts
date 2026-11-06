/**
 * Local approval of a privileged task on its node (doc/privilege.md#本地批准): the `local.request` crhs
 * sends, the node's answer, and sending the request again after the node's privileged mode lost it.
 */
import {
	ConnectionError,
	type LocalDecision,
	type LocalRequest,
	type LocalState,
	RemoteError,
	type TaskSpec,
} from "@crh/protocol";
import type { AuthorizationPath } from "../../privilege/planner.ts";
import { parseTaskAuthorization, serializeTaskAuthorization, type TaskAuthorizationRecord } from "../authorization.ts";
import { type ClusterCore, now } from "../core.ts";
import type { NodeLink } from "../links.ts";
import { newLive } from "../live-output.ts";
import { userCanAccessNode } from "../node-access.ts";
import { getNode } from "../nodes.ts";
import { specFromRow } from "../spec.ts";
import {
	groupEnded,
	NODE_ACCESS_REVOKED,
	NODE_ACCESS_REVOKED_MESSAGE,
	syncGroupState,
	updateTask,
} from "../task-end.ts";
import { pendingInputOf, taskStartOf } from "../task-start.ts";
import { sendAuthorizedStart } from "./authorized-start.ts";
import { finishAuthorization, finishNodeOffline, withoutRequests } from "./common.ts";
import { replanWaiting } from "./plan.ts";

/** A task's local approval request note, shown by `crha pending`. */
const LOCAL_REQUEST_NOTE = "crhs asks for this task to be approved on the node";

/** Sends `local.request` and follows the answer: pending, approved (dispatch) or denied (reject). */
export async function sendLocalRequest(
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
		const updated = record ? withoutRequests(record) : null;
		await finishAuthorization(core, id, row, "rejected", "authorization_rejected", state.message, updated);
		return;
	}
	// Approved: task.start with the approval instead of an authorization (doc/protocol.md#taskstart).
	if (!record) return;
	const before = await getNode(core.db, row.node_id);
	// A connected node dispatches as before. D113: a node that dropped waits for the grace, and a
	// forward privileged task also for the new connection's trust report.
	const ready = await core.readyNode(row.node_id, { trust: before?.privileged_mode === "forward" });
	if (!ready?.link) {
		await finishNodeOffline(core, id, row, withoutRequests(record));
		return;
	}
	const node = ready.node;
	// A member of a group that already ended (interrupted by a restart) never dispatches again.
	if (await groupEnded(core, row.task_group_id)) return;
	// The local approval may arrive long after the task was parked: access can have been revoked since (D108).
	if (!(await userCanAccessNode(core.db, row.on_behalf_of_user_id, node.id))) {
		await finishAuthorization(core, id, row, "failed", NODE_ACCESS_REVOKED, NODE_ACCESS_REVOKED_MESSAGE, record);
		return;
	}
	const spec = specFromRow(row.spec, "task");
	const input = pendingInputOf(row);
	const updated: TaskAuthorizationRecord = { ...withoutRequests(record), dispatchedPath: "local", attempt };
	const claimed = await updateTask(core, id, ["awaiting_authorization"], {
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
	const start = taskStartOf(id, row, spec, { privileged: true, attempt });
	await sendAuthorizedStart(core, node.id, start, input, updated);
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
	await replanWaiting(core, id, row);
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

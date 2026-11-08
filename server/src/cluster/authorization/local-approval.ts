/**
 * Local approval of a privileged task on its node (doc/privilege.md#本地批准): the `local.request` crhs
 * sends, the node's answer, and sending the request again after the node's privileged mode lost it.
 *
 * D118: `local.request` waits for the node's answer, and the dispatch after an approval waits for the
 * node; both run outside any turn. The row is read, decided and written in short turns: one for the
 * decision (a denial ends the task there), one for the claim after the node is ready, each from a fresh
 * read at the row's rev.
 */
import {
	ConnectionError,
	type LocalDecision,
	type LocalRequest,
	type LocalState,
	RemoteError,
	type TaskSpec,
} from "@crh/protocol";
import type { Selectable } from "kysely";
import type { AuthorizationPath } from "../../privilege/planner.ts";
import type { TasksTable } from "../../storage/schema.ts";
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
import { writeTask } from "../task-rows.ts";
import { pendingInputOf, taskStartOf } from "../task-start.ts";
import { type AuthorizedStart, sendAuthorizedStart } from "./authorized-start.ts";
import { finishAuthorization, finishNodeOffline, withoutRequests } from "./common.ts";
import { replanWaiting } from "./plan.ts";

/** A task's local approval request note, shown by `crha pending`. */
const LOCAL_REQUEST_NOTE = "crhs asks for this task to be approved on the node";

/**
 * How much of a task's stdin or file content `local.request` carries, so the approver can see what
 * will be executed without moving the whole input before approval (doc/privilege.md 本地批准).
 */
const INPUT_PREVIEW_BYTES = 4 * 1024;

/** Sends `local.request` and follows the answer: pending, approved (dispatch) or denied (reject). */
export async function sendLocalRequest(
	core: ClusterCore,
	id: string,
	link: NodeLink,
	spec: TaskSpec,
	inputBytes: Uint8Array,
	record: TaskAuthorizationRecord,
): Promise<void> {
	const attempt = record.attempt;
	// local.request waits for the node's answer: never from a task queue turn (D118). Outside the try, so
	// the violation is not mistaken for a failed request and logged away.
	core.assertOutsideTaskTurn("local.request");
	let state: LocalState;
	try {
		const request: LocalRequest = {
			taskId: id,
			attempt,
			spec,
			note: LOCAL_REQUEST_NOTE,
			inputPreview: inputBytes.subarray(0, INPUT_PREVIEW_BYTES),
		};
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
	await onLocalState(core, decision.taskId, decision.attempt, decision.state, link.conn.nodeId);
}

/** What the decision turn found: end here, or wait for the node and claim in a second turn. */
type LocalOutcome = { kind: "settled" } | { kind: "dispatch" };

/**
 * The node's local answer for one attempt (a `local.decision` event or the `local.request` response).
 * The decision is one turn; an approval then waits for the node outside the turn and claims in a turn
 * of its own (D118).
 */
async function onLocalState(
	core: ClusterCore,
	id: string,
	attempt: number,
	state: LocalState,
	nodeId?: string,
): Promise<void> {
	if (state.kind === "pending") return;
	const outcome = await core.taskQueue.run(id, () => localDecisionTurn(core, id, attempt, state, nodeId));
	if (outcome.kind !== "dispatch") return;
	await dispatchLocalApproval(core, id, attempt);
}

/**
 * The decision turn: re-read the row and validate the node (for a `local.decision`), the state and the
 * attempt. A denial ends the task in this same turn; an approval only says to dispatch.
 */
async function localDecisionTurn(
	core: ClusterCore,
	id: string,
	attempt: number,
	state: LocalState,
	nodeId: string | undefined,
): Promise<LocalOutcome> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return { kind: "settled" };
	if (nodeId !== undefined && row.node_id !== nodeId) return { kind: "settled" };
	if (row.attempt !== attempt) return { kind: "settled" };
	const record = parseTaskAuthorization(row.authorization);
	if (state.kind === "denied") {
		// The denial is final for this attempt: the task ends here, in this turn.
		await finishAuthorization(
			core,
			id,
			row,
			"rejected",
			"authorization_rejected",
			state.message,
			record ? withoutRequests(record) : null,
		);
		return { kind: "settled" };
	}
	// An approval without its record cannot dispatch (a stale answer, or a re-plan to another path).
	if (record?.attempt !== attempt) return { kind: "settled" };
	return { kind: "dispatch" };
}

/**
 * Dispatches an approved local task: the offline grace (D113) and a forward task's trust report are
 * waited for outside any turn; the claim is one turn on a fresh read, and the task.start follows outside
 * it. A node that stays offline through the grace ends the task in a turn of its own, on a fresh read.
 */
async function dispatchLocalApproval(core: ClusterCore, id: string, attempt: number): Promise<void> {
	const before = await core.row(id);
	if (before?.state !== "awaiting_authorization" || before.attempt !== attempt) return;
	const node = await getNode(core.db, before.node_id);
	// A connected node dispatches at once. D113: a node that dropped waits for the grace, and a
	// forward privileged task also for the new connection's trust report.
	const ready = await core.readyNode(before.node_id, { trust: node?.privileged_mode === "forward" });
	if (!ready?.link) {
		await core.taskQueue.run(id, async () => {
			// The row may have been cancelled or re-planned while the grace ran: only a still-waiting
			// attempt fails, from the row read in this turn.
			const current = await core.row(id);
			if (current?.state !== "awaiting_authorization" || current.attempt !== attempt) return;
			const record = parseTaskAuthorization(current.authorization);
			await finishNodeOffline(core, id, current, record ? withoutRequests(record) : null);
		});
		return;
	}
	const readyNode = ready.node;
	const claim = await core.taskQueue.run(id, async (): Promise<AuthorizedStart | null> => {
		// The approval may have arrived long ago: re-read and validate the row in this turn (D118).
		const row = await core.row(id);
		if (row?.state !== "awaiting_authorization" || row.attempt !== attempt) return null;
		// A member of a group that already ended (interrupted by a restart) never dispatches again.
		if (await groupEnded(core, row.task_group_id)) return null;
		const record = parseTaskAuthorization(row.authorization);
		if (record?.attempt !== attempt) return null;
		// The local approval may arrive long after the task was parked: access can have been revoked
		// since (D108). The failure is written in this turn.
		if (!(await userCanAccessNode(core.db, row.on_behalf_of_user_id, readyNode.id))) {
			await finishAuthorization(core, id, row, "failed", NODE_ACCESS_REVOKED, NODE_ACCESS_REVOKED_MESSAGE, record);
			return null;
		}
		const spec = specFromRow(row.spec, "task");
		const input = pendingInputOf(row);
		const updated: TaskAuthorizationRecord = { ...withoutRequests(record), dispatchedPath: "local", attempt };
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
		newLive(core, id, readyNode.id, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes);
		core.background("task group state update failed", syncGroupState(core, row.task_group_id));
		const start = taskStartOf(id, row, spec, { privileged: true, attempt });
		return { nodeId: readyNode.id, start, input, record: updated };
	});
	if (!claim) return;
	// The task.start waits for the node's answer: outside the turn that claimed the task (D118).
	await sendAuthorizedStart(core, claim.nodeId, claim.start, claim.input, claim.record);
}

/** Drops the local path after the node refused it, then plans again without it. */
async function dropLocalPath(core: ClusterCore, id: string): Promise<void> {
	const dropped = await core.taskQueue.run(id, async (): Promise<Selectable<TasksTable> | null> => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_authorization") return null;
		const record = parseTaskAuthorization(row.authorization);
		if (!record) return null;
		const updated: TaskAuthorizationRecord = {
			...record,
			local: null,
			tried: [...new Set<AuthorizationPath>([...record.tried, "local"])],
			updatedAt: new Date().toISOString(),
		};
		const written = await writeTask(
			core.db,
			id,
			{ states: ["awaiting_authorization"], rev: row.rev },
			{ authorization: serializeTaskAuthorization(updated) },
		);
		return written ? row : null;
	});
	// The re-plan waits for trust and plans in turns of its own: after this one (D118).
	if (dropped) await replanWaiting(core, id, dropped);
}

/**
 * Sends local.request again for the node's tasks whose approval request the privileged mode lost. The
 * row check is one turn per task; local.request itself waits for the answer, so each request is sent
 * outside the turn, and its answer is handled in turns again (D118).
 */
export async function resendLocalRequests(core: ClusterCore, link: NodeLink): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("node_id", "=", link.conn.nodeId)
		.where("state", "=", "awaiting_authorization")
		.execute();
	for (const { id } of rows) {
		const resend = await core.taskQueue.run(id, async (): Promise<Resend | null> => {
			const row = await core.row(id);
			if (row?.state !== "awaiting_authorization" || link.conn.closed || !link.ready) return null;
			const record = parseTaskAuthorization(row.authorization);
			if (!record || record.local === null) return null;
			return { spec: specFromRow(row.spec, "task"), input: pendingInputOf(row), record };
		});
		if (resend) await sendLocalRequest(core, id, link, resend.spec, resend.input, resend.record);
	}
}

/** What a resend turn decided to send, after the turn. */
interface Resend {
	spec: TaskSpec;
	input: Uint8Array;
	record: TaskAuthorizationRecord;
}

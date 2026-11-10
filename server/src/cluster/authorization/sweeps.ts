/**
 * The sweeps over the tasks that wait for a signature: using an authorization the owner already stored
 * once the node is back, re-planning after the node's trust changed, and ending the waits that ran out
 * (doc/design/privilege.md "Waiting for signatures").
 *
 * Every sweep waits for the node outside any turn; the decision and the writes that follow a
 * fresh read are one short turn per task.
 */
import type { Selectable } from "kysely";
import type { TasksTable } from "../../storage/schema.ts";
import { parseTaskAuthorization } from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import { getNode } from "../nodes.ts";
import { specFromRow } from "../spec.ts";
import { endIfNodeUnready } from "../task-end.ts";
import { parseTrustReport } from "../trust.ts";
import { type ApprovalRecord, AUTHORIZATION_WAIT_MS } from "../types.ts";
import { sendAuthorizedStart } from "./authorized-start.ts";
import { failAliasMissing, finishAuthorization, finishNodeOffline } from "./common.ts";
import {
	type ClaimedAuthorization,
	claimOwnerAuthorization,
	findReusableAuthorization,
} from "./owner-authorizations.ts";
import { replanWaiting } from "./plan.ts";

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
	for (const { id } of rows) await dispatchStored(core, id);
}

/**
 * Uses a stored authorization for one waiting task. The wait for the node and the reuse lookup run
 * outside any turn; the alias failure and the claim are one turn on a fresh read, and the task.start
 * follows outside it. A node that stays away through the grace ends the task in a turn of its own.
 */
async function dispatchStored(core: ClusterCore, id: string): Promise<void> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return;
	// A stored signature is used once the node is back; a node still away after the grace fails
	// the task instead of leaving it waiting forever.
	const ready = await core.waitNodeReady(row.node_id, { trust: true });
	if (!ready?.link) {
		// The row may have been re-planned or ended while the grace ran: end only a still-waiting task.
		await endIfNodeUnready(core, id, ready, async (current) => {
			if (current.state !== "awaiting_authorization") return;
			await finishNodeOffline(core, id, current, parseTaskAuthorization(current.authorization));
		});
		return;
	}
	const nodeId = ready.node.id;
	const link = ready.link;
	const claim = await core.taskQueue.run(id, async (): Promise<ClaimedAuthorization | null> => {
		// The caller's row predates the wait for the node; re-read it in this turn.
		const current = await core.row(id);
		if (current?.state !== "awaiting_authorization") return null;
		// The reuse lookup is judged against this connection's trust report; re-read the node so a report
		// that arrived during the wait is the one used (a newer one only makes the node stricter, and a
		// rejection is retried by the send path).
		const fresh = await getNode(core.db, current.node_id);
		const report = fresh ? parseTrustReport(fresh.trust_report) : null;
		if (!fresh || !link.trustFresh || report?.kind !== "ok") return null;
		const previous = parseTaskAuthorization(current.authorization);
		const skip = new Set<string>();
		if (previous?.lastRejection && previous.payloadId) skip.add(previous.payloadId);
		const reusable = await findReusableAuthorization(
			core,
			current,
			fresh,
			report.summary,
			specFromRow(current.spec, "task"),
			skip,
		);
		if (!reusable) return null;
		if (reusable.kind === "alias_missing") {
			// Only a missing node group alias stands in the way: the failure ends the task here.
			await failAliasMissing(core, current, previous, reusable);
			return null;
		}
		return claimOwnerAuthorization(core, current, fresh, link, reusable.submitted, reusable.cosigned);
	});
	if (!claim) return;
	// The task.start waits for the node's answer: outside the turn that claimed the task.
	await sendAuthorizedStart(core, nodeId, claim.start, claim.input, claim.record);
}

/** Re-plans the node's tasks that wait for an authorization signature after its trust digest changed. */
export async function replanAwaiting(core: ClusterCore, nodeId: string): Promise<void> {
	const rows = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("node_id", "=", nodeId)
		.where("state", "=", "awaiting_authorization")
		.execute();
	// replanWaiting waits for the node's trust report outside a turn and plans in one; the read
	// below is only a pre-check, the planning turn re-checks the row.
	for (const { id } of rows) await replan(core, id);
}

async function replan(core: ClusterCore, id: string): Promise<void> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return;
	await replanWaiting(core, id, row);
}

/**
 * Ends the tasks whose signature has not arrived within AUTHORIZATION_WAIT_MS since they began to wait
 * (doc/design/privilege.md "Waiting for signatures"): from the approval decision when there was one, else from creation.
 * Run at startup and by the periodic sweep; returns how many tasks it ended.
 */
export async function expireAuthorizationWaits(core: ClusterCore, nowMs: number = Date.now()): Promise<number> {
	const rows = await core.db.selectFrom("tasks").selectAll().where("state", "=", "awaiting_authorization").execute();
	let ended = 0;
	for (const row of rows) {
		if (nowMs - authorizationWaitStart(row) < AUTHORIZATION_WAIT_MS) continue;
		// The ending is a read-decide-write on the task's row: one turn, from a fresh read.
		const finished = await core.taskQueue.run(row.id, async () => {
			const current = await core.row(row.id);
			if (current?.state !== "awaiting_authorization") return false;
			if (nowMs - authorizationWaitStart(current) < AUTHORIZATION_WAIT_MS) return false;
			return finishAuthorization(
				core,
				row.id,
				current,
				"rejected",
				"authorization_wait_expired",
				`no signature arrived within ${AUTHORIZATION_WAIT_MS / 3_600_000} hours`,
				parseTaskAuthorization(current.authorization),
			);
		});
		if (finished) ended++;
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

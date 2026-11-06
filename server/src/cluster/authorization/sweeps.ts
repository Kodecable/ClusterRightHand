/**
 * The sweeps over the tasks that wait for a signature: using an authorization the owner already stored
 * once the node is back, re-planning after the node's trust changed, and ending the waits that ran out
 * (doc/privilege.md#等待签名的期限).
 */
import type { Selectable } from "kysely";
import type { TasksTable } from "../../storage/schema.ts";
import { parseTaskAuthorization } from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import { specFromRow } from "../spec.ts";
import { parseTrustReport } from "../trust.ts";
import { type ApprovalRecord, AUTHORIZATION_WAIT_MS } from "../types.ts";
import { failAliasMissing, finishAuthorization, finishNodeOffline } from "./common.ts";
import { dispatchOwnerAuthorization, findReusableAuthorization } from "./owner-authorizations.ts";
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
	for (const { id } of rows) await core.taskQueue.run(id, () => dispatchStored(core, id));
}

async function dispatchStored(core: ClusterCore, id: string): Promise<void> {
	const row = await core.row(id);
	if (row?.state !== "awaiting_authorization") return;
	// D113: a stored signature is used once the node is back; a node still away after the grace fails
	// the task instead of leaving it waiting forever.
	const ready = await core.waitNodeReady(row.node_id, { trust: true });
	if (!ready?.link) {
		await finishNodeOffline(core, id, row, parseTaskAuthorization(row.authorization));
		return;
	}
	const node = ready.node;
	const link = ready.link;
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
	if (reusable?.kind !== "found") {
		if (reusable?.kind === "alias_missing") await failAliasMissing(core, row, previous, reusable);
		return;
	}
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
	await replanWaiting(core, id, row);
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

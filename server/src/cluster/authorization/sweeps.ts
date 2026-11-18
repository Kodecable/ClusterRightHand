/**
 * The sweep over the tasks that wait for an authorization (doc/design/privilege.md "Waiting for
 * signatures"): ending the waits that ran out, and syncing the units a pass or a refresh timer missed
 * (crhs stopped in the middle of a pass, or a payload came due while it was down).
 *
 * The decision and the write that follows a fresh read are one short turn per task; the syncs are only
 * requested.
 */
import type { Selectable } from "kysely";
import type { TasksTable } from "../../storage/schema.ts";
import { parseTaskAuthorization } from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import { type ApprovalRecord, AUTHORIZATION_WAIT_MS } from "../types.ts";
import { finishAuthorization } from "./common.ts";
import { syncStaleAuthorizationWaits } from "./sync.ts";

/**
 * Ends the tasks whose authorization has not arrived within AUTHORIZATION_WAIT_MS since they began to
 * wait (from the approval decision when there was one, else from creation), then asks for a sync of
 * every remaining wait with no options or a payload due for a refresh. A timed-out wait ends `expired`,
 * not `rejected`: nobody rejected it. Run at startup and by the periodic sweep; returns how many tasks
 * it ended.
 */
export async function sweepAuthorizationWaits(core: ClusterCore, nowMs: number = Date.now()): Promise<number> {
	const rows = await core.db.selectFrom("tasks").selectAll().where("state", "=", "awaiting_authorization").execute();
	let ended = 0;
	const waiting: Selectable<TasksTable>[] = [];
	for (const row of rows) {
		try {
			if (nowMs - authorizationWaitStart(row) < AUTHORIZATION_WAIT_MS) {
				waiting.push(row);
				continue;
			}
			// The ending is a read-decide-write on the task's row: one turn, from a fresh read.
			const finished = await core.taskQueue.run(row.id, async () => {
				const current = await core.row(row.id);
				if (current?.state !== "awaiting_authorization") return false;
				if (nowMs - authorizationWaitStart(current) < AUTHORIZATION_WAIT_MS) return false;
				return finishAuthorization(
					core,
					row.id,
					current,
					"expired",
					"authorization_wait_expired",
					`no signature arrived within ${AUTHORIZATION_WAIT_MS / 3_600_000} hours`,
					parseTaskAuthorization(current.authorization),
				);
			});
			if (finished) ended++;
		} catch (err) {
			// A row that cannot be ended (a bad row, or a transient database error) must not stop
			// the expiry of every later row.
			console.error(`expiring the authorization wait of task ${row.id} failed:`, err);
		}
	}
	syncStaleAuthorizationWaits(core, waiting);
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

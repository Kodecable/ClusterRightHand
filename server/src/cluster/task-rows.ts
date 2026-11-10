/**
 * The only writers of the `tasks` table: every task-row write goes through here, and every one of
 * them bumps `rev`.
 *
 * A write whose content or decision came from a row the caller read earlier names the `rev` it read. If
 * the row changed in between (another path wrote it, bumping `rev`), the guarded write matches nothing and
 * returns false: the caller then behaves like it would have when the state no longer matched, instead of
 * writing a stale decision back. Node-event writes react to a fact reported by the node, not to an earlier
 * read, so they keep only their state/node guards.
 */
import { type Insertable, type Kysely, sql, type Updateable } from "kysely";
import type { Database, TaskState, TasksTable } from "../storage/schema.ts";
import { currentTurns } from "../util/keyed-queue.ts";

/**
 * The label ClusterCore gives its task queue (core.ts). A task-row turn is a turn of that queue on the
 * task's own id; the dev check below recognizes it by this label.
 */
export const TASK_QUEUE_LABEL = "task queue";

/** Where a write may say why it is allowed outside the task's turn. */
export interface TaskRowWriteOptions {
	/**
	 * Allows a rev-guarded write outside a turn of the task's queue. Only the documented exceptions use
	 * it: a cancel (the user's own decision, retried against the current row) and the task-group payload
	 * refresh (writes member rows at their rev on the group queue, never entering a member's task queue).
	 */
	outOfTurn?: boolean;
}

/** Whether the out-of-turn write has been reported in production; a violation never crashes the cluster. */
let reportedOutOfTurn = false;

/**
 * A write derived from a read row names the `rev` it read, so it must run in a turn of that
 * task's queue, where the read and the write cannot be split by another path. Under tests a violation
 * throws (a regression fails the suite); in production it is logged once and the write continues.
 */
function assertTaskRowTurn(id: string): void {
	if (currentTurns().some((turn) => turn.queue === TASK_QUEUE_LABEL && turn.key === id)) return;
	const message = `task ${id}: a rev-guarded task write outside the task queue turn`;
	if (process.env.VITEST) throw new Error(message);
	if (reportedOutOfTurn) return;
	reportedOutOfTurn = true;
	console.error(`${message}\n${new Error(message).stack ?? ""}`);
}

/** What a task-row write must match. `{}` is the explicit choice for the few node-side writes that need no guard. */
export interface TaskRowGuard {
	/** The row version the caller read; the write matches nothing after another path bumped it. */
	rev?: number;
	/** The states the write is allowed to move the task out of. */
	states?: readonly TaskState[];
	/** The node the task must still be on (node-event writes). */
	nodeId?: string;
}

/** The mutable columns a write may set; `rev` is the writer's, never a caller's. */
export type TaskRowUpdate = Omit<Updateable<TasksTable>, "rev">;

/**
 * Writes one task row, bumping its `rev`, and returns whether a row matched. Every given guard is a WHERE
 * clause, so a stale `rev` (or a state/node that moved) simply matches nothing.
 */
export async function writeTask(
	db: Kysely<Database>,
	id: string,
	guard: TaskRowGuard,
	set: TaskRowUpdate,
	options: TaskRowWriteOptions = {},
): Promise<boolean> {
	// An omitted guard must not silently mean "write whatever is there now": callers with no better
	// guard pass `{}` on purpose.
	if (!guard) throw new Error(`task ${id}: a task write needs an explicit guard`);
	if (guard.states && guard.states.length === 0) {
		throw new Error(`task ${id}: a task write with an empty state list can never match`);
	}
	// A write that trusts the rev it read is a decision from that row: it belongs to the task's turn.
	if (guard.rev !== undefined && !options.outOfTurn) assertTaskRowTurn(id);
	let update = db
		.updateTable("tasks")
		.set({ ...set, rev: sql<number>`rev + 1` })
		.where("id", "=", id);
	if (guard.rev !== undefined) update = update.where("rev", "=", guard.rev);
	if (guard.states) update = update.where("state", "in", [...guard.states]);
	if (guard.nodeId !== undefined) update = update.where("node_id", "=", guard.nodeId);
	const result = await update.executeTakeFirst();
	return (result?.numUpdatedRows ?? 0n) > 0n;
}

/** Inserts a new task row; its `rev` starts at the column default, 0. */
export async function insertTask(db: Kysely<Database>, values: Insertable<TasksTable>): Promise<void> {
	await db.insertInto("tasks").values(values).execute();
}

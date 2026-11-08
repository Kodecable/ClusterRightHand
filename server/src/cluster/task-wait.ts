/** Reading a task, waiting for its end and cancelling it (doc/execution-plane.md#状态机). */
import { withdrawLocal } from "./authorization/common.ts";
import { parseTaskAuthorization } from "./authorization.ts";
import type { ClusterCore } from "./core.ts";
import { CANCELLED_BEFORE_START_MESSAGE, cancelledTaskFields, endTask, requestTaskCancel } from "./task-end.ts";
import { toView } from "./task-view.ts";
import { type Actor, type TaskView, TERMINAL } from "./types.ts";

export async function getTask(core: ClusterCore, id: string): Promise<TaskView | undefined> {
	const row = await core.row(id);
	return row ? toView(row, core.live.get(id)) : undefined;
}

/**
 * Several tasks in one query, in the input order. An id that no longer has a row is omitted, like a
 * `getTask` that returned undefined; a caller showing a list (approvals, signatures) must not read per row.
 */
export async function getTasks(core: ClusterCore, ids: readonly string[]): Promise<TaskView[]> {
	if (ids.length === 0) return [];
	const rows = await core.db
		.selectFrom("tasks")
		.selectAll()
		.where("id", "in", [...new Set(ids)])
		.execute();
	const byId = new Map(rows.map((row) => [row.id, toView(row, core.live.get(row.id))]));
	const out: TaskView[] = [];
	for (const id of ids) {
		const view = byId.get(id);
		if (view) out.push(view);
	}
	return out;
}

/** A group's tasks in creation order, in one query: a batch shows every member, one read per member is N+1. */
export async function groupTasks(core: ClusterCore, groupId: string): Promise<TaskView[]> {
	const rows = await core.db
		.selectFrom("tasks")
		.selectAll()
		.where("task_group_id", "=", groupId)
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	return rows.map((row) => toView(row, core.live.get(row.id)));
}

/**
 * Waits until the task is in a final state, the timeout passes or endWaits() ends the waits; returns its
 * current view (never undefined for an existing task). A wait ended by shutdown returns at once, so a
 * handler holding it does not hold the drain; close() runs before the database is destroyed, so that
 * read is safe.
 */
export async function waitTask(
	core: ClusterCore,
	id: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<TaskView | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const view = await getTask(core, id);
		if (!view || TERMINAL.has(view.state) || core.waitsEnded || Date.now() >= deadline || signal?.aborted) {
			return view;
		}
		await new Promise<void>((resolve) => {
			const waiters = core.waiters.get(id) ?? new Set();
			core.waiters.set(id, waiters);
			const done = () => {
				clearTimeout(timer);
				waiters.delete(done);
				// A wait that timed out or was aborted leaves no empty set behind; only a notify removes the
				// whole entry otherwise, and a task nobody wakes again would keep one.
				if (waiters.size === 0 && core.waiters.get(id) === waiters) core.waiters.delete(id);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, deadline - Date.now());
			signal?.addEventListener("abort", done);
			waiters.add(done);
		});
	}
}

/**
 * Asks the node to cancel a running task. A task that still waits for its approval or its
 * authorization signature was never dispatched, so it ends here instead (there is no node-side task).
 * A task that was claimed for dispatch records the request on its row first, so the dispatch path
 * that has not sent task.start yet ends it instead of running it (doc/execution-plane.md#任务取消).
 * Returns false if the task already ended, or when it runs and the node is offline. `message` replaces
 * the default reason of a task that ends before dispatch (e.g. its session was stopped). `by` is the
 * actor who asked for the cancellation: the task.finished audit event names it, or the system when it
 * is absent.
 */
export async function cancelTask(
	core: ClusterCore,
	id: string,
	message = CANCELLED_BEFORE_START_MESSAGE,
	by?: Actor,
): Promise<boolean> {
	let row = await core.row(id);
	if (!row || TERMINAL.has(row.state)) return false;
	let flagged = false;
	if (row.state === "dispatched") {
		// The claim may turn into running while this runs (onAccepted), or back to waiting after an
		// authorization retry: follow the row instead of cancelling against a stale state.
		for (;;) {
			const res = await core.db
				.updateTable("tasks")
				.set({ cancelled: 1 })
				.where("id", "=", id)
				.where("state", "=", "dispatched")
				.executeTakeFirst();
			if (res.numUpdatedRows > 0n) {
				flagged = true;
				break;
			}
			const current = await core.row(id);
			if (!current || TERMINAL.has(current.state)) return false;
			row = current;
			if (row.state !== "dispatched") break;
		}
	}
	if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") {
		if (by) core.cancelledBy.set(id, by);
		const record = parseTaskAuthorization(row.authorization);
		const link = core.links.get(row.node_id);
		return endTask(core, id, {
			write: { from: [row.state], set: cancelledTaskFields(message) },
			afterWrite: () => withdrawLocal(link, id, record),
			group: row.task_group_id,
			onChange: row.actor_id,
		});
	}
	if (flagged && by) core.cancelledBy.set(id, by);
	const ssh = core.sshCancels.get(id);
	if (ssh) {
		if (by) core.cancelledBy.set(id, by);
		ssh.abort();
		return true;
	}
	if (requestTaskCancel(core, row.node_id, id)) {
		if (by) core.cancelledBy.set(id, by);
		return true;
	}
	return flagged;
}

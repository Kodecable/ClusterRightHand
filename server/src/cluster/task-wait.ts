/** Reading a task, waiting for its end and cancelling it (doc/execution-plane.md#状态机). */
import { ConnectionError } from "@crh/protocol";
import { withdrawLocal } from "./authorization/common.ts";
import { parseTaskAuthorization } from "./authorization.ts";
import type { ClusterCore } from "./core.ts";
import { endTask } from "./task-end.ts";
import { toView } from "./task-view.ts";
import { type Actor, type TaskView, TERMINAL } from "./types.ts";

export async function getTask(core: ClusterCore, id: string): Promise<TaskView | undefined> {
	const row = await core.row(id);
	return row ? toView(row, core.live.get(id)) : undefined;
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
 * Returns false if the task already ended or the node is offline. `message` replaces the default reason of
 * a task that ends before dispatch (e.g. its session was stopped). `by` is the actor who asked for the
 * cancellation: the task.finished audit event names it, or the system when it is absent.
 */
export async function cancelTask(
	core: ClusterCore,
	id: string,
	message = "the task was cancelled before it was dispatched",
	by?: Actor,
): Promise<boolean> {
	const row = await core.row(id);
	if (!row || TERMINAL.has(row.state)) return false;
	if (by) core.cancelledBy.set(id, by);
	if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") {
		const record = parseTaskAuthorization(row.authorization);
		const link = core.links.get(row.node_id);
		return endTask(core, id, {
			write: {
				from: [row.state],
				set: {
					state: "rejected",
					error_code: "cancelled",
					error_message: message,
					cancelled: 1,
					pending_input: null,
					handler_type: null,
					handler_session_id: null,
				},
			},
			afterWrite: () => withdrawLocal(link, id, record),
			group: row.task_group_id,
			onChange: row.actor_id,
		});
	}
	const ssh = core.sshCancels.get(id);
	if (ssh) {
		ssh.abort();
		return true;
	}
	const link = core.links.get(row.node_id);
	if (!link?.ready) return false;
	void link.conn.peer.request("task.cancel", { taskId: id }).catch((err: unknown) => {
		if (!(err instanceof ConnectionError)) console.error(`task.cancel for ${id} failed:`, err);
	});
	return true;
}

/** Reading a task, waiting for its end and cancelling it (doc/design/execution.md "State machine"). */
import type { Selectable } from "kysely";
import { requestSourceFor, requestSourcesFor, sourceActorKey } from "../request-source.ts";
import type { TasksTable } from "../storage/schema.ts";
import type { ClusterCore } from "./core.ts";
import { CANCELLED_BEFORE_START_MESSAGE, cancelledTaskFields, endTask, requestTaskCancel } from "./task-end.ts";
import { toView } from "./task-view.ts";
import { type Actor, type TaskView, TERMINAL } from "./types.ts";

export async function getTask(core: ClusterCore, id: string): Promise<TaskView | undefined> {
	const row = await core.row(id);
	if (!row) return undefined;
	const source = await requestSourceFor(core.db, row.actor_type, row.actor_id, row.on_behalf_of_user_id);
	return toView(row, core.live.get(id), source);
}

/** Several rows as views, resolving each distinct request source once instead of one query per row. */
async function viewsOf(core: ClusterCore, rows: readonly Selectable<TasksTable>[]): Promise<TaskView[]> {
	const sources = await requestSourcesFor(
		core.db,
		rows.map((row) => ({
			actorType: row.actor_type,
			actorId: row.actor_id,
			onBehalfOfUserId: row.on_behalf_of_user_id,
		})),
	);
	return rows.map((row) => {
		const source = sources.get(sourceActorKey(row.actor_type, row.actor_id, row.on_behalf_of_user_id));
		if (source === undefined) throw new Error("the task's request source was not resolved");
		return toView(row, core.live.get(row.id), source);
	});
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
	const views = await viewsOf(core, rows);
	const byId = new Map(views.map((view) => [view.id, view] as const));
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
	return viewsOf(core, rows);
}

/** Several groups' tasks in one query, each group in creation order; a group with no rows has no entry. */
export async function groupTasksMany(core: ClusterCore, groupIds: readonly string[]): Promise<Map<string, TaskView[]>> {
	const groupIdSet = [...new Set(groupIds)];
	if (groupIdSet.length === 0) return new Map();
	const rows = await core.db
		.selectFrom("tasks")
		.selectAll()
		.where("task_group_id", "in", groupIdSet)
		.orderBy("created_at")
		.orderBy("id")
		.execute();
	const byGroup = new Map<string, TaskView[]>();
	const views = await viewsOf(core, rows);
	for (const [index, row] of rows.entries()) {
		const view = views[index];
		if (row.task_group_id === null || view === undefined) continue;
		const group = byGroup.get(row.task_group_id);
		if (group) group.push(view);
		else byGroup.set(row.task_group_id, [view]);
	}
	return byGroup;
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

/** How often a cancel of a waiting task re-reads a row another path keeps changing. */
const CANCEL_ROUNDS = 5;

/**
 * Asks the node to cancel a running task. A task that still waits for its approval or its
 * authorization signature was never dispatched, so it ends here as `cancelled` (there is no node-side
 * task). A task that was claimed for dispatch ends `cancelled` on its row as well, so the dispatch path
 * that has not sent task.start yet stops at the start point; the node is still told, so a start already
 * on its way is cancelled and its output is kept (doc/design/execution.md "Task cancellation").
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
	let ended = false;
	if (row.state === "dispatched") {
		// The task was claimed but may or may not have reached the node. Record the cancellation on the row
		// first, so a send that has not left yet stops at the start point and a restart cannot lose it; the
		// live output stays for a late task.exit that still carries what ran (see finish()).
		if (by) core.cancelledBy.set(id, by);
		for (;;) {
			const cancelledNow = await endTask(core, id, {
				write: { from: ["dispatched"], rev: row.rev, outOfTurn: true, set: cancelledTaskFields(message) },
				live: "keep",
				group: row.task_group_id,
				onChange: row.actor_id,
			});
			if (cancelledNow) {
				ended = true;
				break;
			}
			const current = await core.row(id);
			if (!current || TERMINAL.has(current.state)) return false;
			row = current;
			if (row.state !== "dispatched") break;
		}
		// Stop the transport even when the row was ended here: an SSH run may already be connecting, and
		// the node may have received task.start before the cancellation did (or remembers the id for a
		// start that arrives later).
		const ssh = core.sshCancels.get(id);
		if (ssh) {
			ssh.abort();
			return true;
		}
		if (requestTaskCancel(core, row.node_id, id)) return true;
		return ended;
	}
	if (row.state === "awaiting_approval" || row.state === "awaiting_authorization") {
		if (by) core.cancelledBy.set(id, by);
		// A cancel is the user's decision, not one derived from the row: when another path bumped `rev` in
		// between (a group refresh, an authorization sync), read again and cancel the current row instead of giving up.
		for (let attempt = 0; attempt < CANCEL_ROUNDS; attempt++) {
			const written = await endTask(core, id, {
				write: { from: [row.state], rev: row.rev, outOfTurn: true, set: cancelledTaskFields(message) },
				group: row.task_group_id,
				onChange: row.actor_id,
			});
			if (written) return true;
			const current = await core.row(id);
			if (!current || (current.state !== "awaiting_approval" && current.state !== "awaiting_authorization")) {
				// It left the waiting states meanwhile (dispatched, or ended): cancel it as what it is now.
				return current && !TERMINAL.has(current.state) ? cancelTask(core, id, message, by) : false;
			}
			row = current;
		}
		return false;
	}
	// A running SSH task is aborted here and its runner records the end with the output it saw.
	if (by) core.cancelledBy.set(id, by);
	const ssh = core.sshCancels.get(id);
	if (ssh) {
		ssh.abort();
		return true;
	}
	return requestTaskCancel(core, row.node_id, id);
}

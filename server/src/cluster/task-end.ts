/**
 * The ends of a task (doc/execution-plane.md#状态机): the node's reports of acceptance and exit, the
 * guarded write of a terminal row and the side effects every ending shares (the live output, the
 * waiters, the group's state, the session inbox and the task.finished audit).
 */
import { createHash } from "node:crypto";
import { ConnectionError, type TaskExit, taskResultToJson } from "@crh/protocol";
import type { Insertable, Selectable, Updateable } from "kysely";
import type { TaskState as TaskRowState, TasksTable } from "../storage/schema.ts";
import type { NodeConnection } from "./connection.ts";
import { type ClusterCore, now, type ReadyNode } from "./core.ts";
import { dropLive, EMPTY_OUTPUT, keepUnknownOutput, newLive } from "./live-output.ts";
import { insertTask, writeTask } from "./task-rows.ts";
import { outputColumns } from "./task-view.ts";
import { type Actor, GROUP_TERMINAL, recorded, TASK_CANCELLED_CODE, TERMINAL } from "./types.ts";

/**
 * The row write that ends a task: an update of a task that was running, or the insert of a task that
 * is denied as it is created (which never exists in a non-terminal state).
 */
type TaskRowWrite =
	| {
			/** Creates the row; `ended` says whether it is already terminal (a task denied at creation). */
			insert: Insertable<TasksTable>;
			ended: boolean;
	  }
	| {
			from: readonly TaskRowState[];
			set: Updateable<TasksTable>;
			nodeId?: string;
			rev?: number;
			/** The documented out-of-turn ending (a cancel, see task-rows.ts#TaskRowWriteOptions). */
			outOfTurn?: boolean;
	  };

/**
 * One ending of a task: the row write, then the side effects every ending shares, in this order: the
 * live output, the waiters, the group's state, the session inbox and the task.finished audit. The
 * options say which of them apply; see each call site for the combination it needs.
 */
interface TaskEnd {
	write: TaskRowWrite;
	/** What happens to the live output; "none" for a task that never had one (it was still waiting). */
	live?: "drop" | "keep" | "none";
	/**
	 * Whether the live output and the waiters are handled even when the write matched no row: the
	 * dispatch side must clean up after a task another path has already ended.
	 */
	always?: boolean;
	/** Whether the waiters are woken (default true). */
	notify?: boolean;
	/**
	 * The group whose state is re-derived after the write: an id, the task's own group ("row"), or
	 * null for none. The group of a task that never started is not synced today (see the call sites).
	 */
	group?: string | null | "row";
	/** Whether the group sync is awaited (the dispatch side does) or left in the background. */
	awaitGroup?: boolean;
	/** The actor whose session state changed; the runtime refreshes its inbox. */
	onChange?: string;
	/** Whether task.finished is audited (default true); the approval paths audit themselves. */
	audit?: boolean;
	/** Runs after the row was written (and matched), after the waiters are woken: an outstanding local request. */
	afterWrite?: () => void;
}

/** The error code of a task stopped because its on_behalf_of user lost access to the node. */
export const NODE_ACCESS_REVOKED = "node_access_revoked";
/** The error message that goes with NODE_ACCESS_REVOKED. */
export const NODE_ACCESS_REVOKED_MESSAGE = "access to the node was revoked before the task was dispatched";
/** The error code of a task a previous process left between its claim and its dispatch. */
export const DISPATCH_INTERRUPTED = "dispatch_interrupted";
/** The error message that goes with DISPATCH_INTERRUPTED. */
export const DISPATCH_INTERRUPTED_MESSAGE = "the server stopped before the task was dispatched";
/** The error code of a waiting task whose node was deleted before it could dispatch. */
export const NODE_DELETED = "node_deleted";
/** The error message that goes with NODE_DELETED. */
export const NODE_DELETED_MESSAGE = "the node was deleted before the task was dispatched";
/** The reason of a task cancelled after it was claimed but before it reached the node. */
export const CANCELLED_BEFORE_START_MESSAGE = "the task was cancelled before it was dispatched";
/** The error code of a task whose node never became ready within the offline grace (D113). */
export const NODE_OFFLINE = "node_offline";
/** The error message that goes with NODE_OFFLINE. */
export const NODE_OFFLINE_MESSAGE = "the node is not connected";

// ---- endings before dispatch ----

/**
 * The terminal row of a task cancelled after it was claimed (or while it waited) but before it started:
 * nothing ran, so it is `rejected`/`cancelled` like a waiting task a cancel ends.
 */
export function cancelledTaskFields(message = CANCELLED_BEFORE_START_MESSAGE): Updateable<TasksTable> {
	return {
		state: "rejected",
		error_code: TASK_CANCELLED_CODE,
		error_message: message,
		cancelled: 1,
		pending_input: null,
		handler_type: null,
		handler_session_id: null,
	};
}

/** Ends a waiting task whose on_behalf_of user no longer has access to the node (D108). */
export async function failNodeAccessRevoked(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	from: readonly TaskRowState[],
): Promise<void> {
	await endTask(core, id, {
		write: {
			from,
			rev: row.rev,
			set: {
				state: "failed",
				error_code: NODE_ACCESS_REVOKED,
				error_message: NODE_ACCESS_REVOKED_MESSAGE,
				pending_input: null,
				handler_type: null,
				handler_session_id: null,
			},
		},
		live: "none",
		group: row.task_group_id ?? null,
		awaitGroup: true,
		onChange: row.actor_id,
	});
}

/** How one node_offline ending ends its task: the states it may still be in, and the side effects it had. */
interface NodeOfflineEnd {
	/** The states the task may still be in for this ending to apply. */
	from: readonly TaskRowState[];
	/** The row this ending read: its rev guards the write, and its group and actor drive the side effects. */
	row?: Pick<Selectable<TasksTable>, "rev" | "task_group_id" | "actor_id">;
	/** Fields the caller records with the failure (its authorization record, a cleared dispatch stamp). */
	set?: Updateable<TasksTable>;
	/** The node the task was being sent to; with it the write matches only that task on that node. */
	nodeId?: string;
	/** What happens to the live output; "none" for a task that never had one (it was still waiting). */
	live?: "drop" | "keep" | "none";
	/** The group whose state is re-derived; defaults to the row's own group. */
	group?: string | null | "row";
	/** Whether the group sync is awaited (the dispatch side does). */
	awaitGroup?: boolean;
	/** The dispatch side must clean up after a task another path has already ended. */
	always?: boolean;
}

/**
 * Ends a task whose node never became ready within the offline grace (D113), from whichever states it
 * still waits in: the plain dispatch's awaiting_approval, a signature wait's state, or the dispatch
 * side's dispatched/running. Every ending writes the same failure columns; `end` keeps the side effects
 * each site had (the live output, the group sync, the actor refresh).
 */
export async function failNodeOffline(core: ClusterCore, id: string, end: NodeOfflineEnd): Promise<boolean> {
	return endTask(core, id, {
		write: {
			from: end.from,
			rev: end.row?.rev,
			nodeId: end.nodeId,
			set: {
				state: "failed",
				error_code: NODE_OFFLINE,
				error_message: NODE_OFFLINE_MESSAGE,
				pending_input: null,
				handler_type: null,
				handler_session_id: null,
				...end.set,
			},
		},
		live: end.live ?? "none",
		...(end.always ? { always: true } : {}),
		group: end.group ?? end.row?.task_group_id ?? null,
		...(end.awaitGroup ? { awaitGroup: true } : {}),
		onChange: end.row?.actor_id,
	});
}

/**
 * The failure branch of a dispatch that waited for its node: the wait itself ran outside any turn
 * (D118); `ready` without a link means the ending runs in the task's own turn, on a fresh read, so a
 * cancellation or another ending that settled the row meanwhile is not overwritten. `end` decides from
 * that row whether it still needs ending.
 */
export async function endIfNodeUnready(
	core: ClusterCore,
	id: string,
	ready: ReadyNode | undefined,
	end: (row: Selectable<TasksTable>) => Promise<void>,
): Promise<void> {
	if (ready?.link) return;
	await core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row) await end(row);
	});
}

/**
 * Ends a task that was written as `awaiting_approval` only to be dispatched at once, when the dispatch
 * threw before touching the row (doc/execution-plane.md#状态机): leaving it waiting would show an approval
 * nobody can decide. The error is logged, not raised, so the caller sees the failure that caused it.
 */
export async function endUndispatched(core: ClusterCore, id: string, error: unknown): Promise<void> {
	try {
		await endTask(core, id, {
			write: {
				from: ["awaiting_approval"],
				set: {
					state: "failed",
					error_code: "internal_error",
					error_message: error instanceof Error ? error.message : String(error),
					pending_input: null,
					handler_type: null,
					handler_session_id: null,
				},
			},
		});
	} catch (cleanupError) {
		console.error(`task ${id}: ending a task whose dispatch failed failed:`, cleanupError);
	}
}

/**
 * Ends a waiting task whose node no longer exists: there is nothing left to dispatch it to, and without a
 * node row every later check would report success without ever sending it. `set` carries what the caller
 * recorded with the ending (an approval decision, for instance). Returns whether the row matched.
 */
export async function failNodeDeleted(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	set: Updateable<TasksTable> = {},
): Promise<boolean> {
	return endTask(core, id, {
		write: {
			from: [row.state],
			rev: row.rev,
			set: {
				state: "failed",
				error_code: NODE_DELETED,
				error_message: NODE_DELETED_MESSAGE,
				pending_input: null,
				handler_type: null,
				handler_session_id: null,
				...set,
			},
		},
		live: "none",
		group: row.task_group_id ?? null,
		awaitGroup: true,
		onChange: row.actor_id,
	});
}

/**
 * Ends the waiting tasks of a node that was just deleted (doc/execution-plane.md#状态机): `tasks.node_id`
 * has no foreign key, so the rows stay behind and nothing would ever dispatch them. Each ending runs in
 * that task's own turn, on the row read there, so it cannot overwrite an approval or a cancellation that
 * settled the task meanwhile. Returns how many rows ended.
 */
export async function endNodeTasks(core: ClusterCore, nodeId: string): Promise<number> {
	const rows = await core.db
		.selectFrom("tasks")
		.select("id")
		.where("node_id", "=", nodeId)
		.where("state", "in", ["awaiting_approval", "awaiting_authorization"])
		.execute();
	let ended = 0;
	for (const { id } of rows) {
		await core.taskQueue.run(id, async () => {
			const row = await core.row(id);
			if (row?.node_id !== nodeId) return;
			if (row.state !== "awaiting_approval" && row.state !== "awaiting_authorization") return;
			if (await failNodeDeleted(core, id, row)) ended++;
		});
	}
	return ended;
}

// ---- the node's reports ----

/** The node accepted the start: the task runs. */
export async function onAccepted(core: ClusterCore, nodeId: string, taskId: string): Promise<void> {
	await writeTask(core.db, taskId, { states: ["dispatched"], nodeId }, { state: "running", accepted_at: now() });
	core.notify(taskId);
	// The cancel may have reached the node before its task.start, or the start may have overtaken the
	// cancel: the node now knows the task, so the cancel has to follow it (doc/execution-plane.md#任务取消).
	const row = await core.row(taskId);
	if (row?.cancelled === 1) requestTaskCancel(core, nodeId, taskId);
}

/**
 * Sends task.cancel without awaiting the answer. A node that does not know the task accepts it and
 * remembers the id, so a task.start arriving afterwards is refused with `cancelled`.
 * Returns false when the node has no ready link.
 */
export function requestTaskCancel(core: ClusterCore, nodeId: string, taskId: string): boolean {
	const link = core.links.get(nodeId);
	if (!link?.ready) return false;
	void link.conn.peer.request("task.cancel", { taskId }).catch((err: unknown) => {
		if (!(err instanceof ConnectionError)) console.error(`task.cancel for ${taskId} failed:`, err);
	});
	return true;
}

/** task.exit: the node reports the task's end, with the output it says it sent before it. */
export async function onExit(core: ClusterCore, conn: NodeConnection, exit: TaskExit): Promise<void> {
	const row = await core.row(exit.taskId);
	if (!row || row.node_id !== conn.nodeId) return;
	const existing = core.live.get(exit.taskId);
	// The result is already recorded and crha resent task.exit after a lost task.exit.ack: there is no
	// live record to complete, and re-sending the task must not close the connection in a loop.
	if (recorded(row.state) && !existing) {
		conn.peer.emit("task.exit.ack", { taskId: row.id });
		return;
	}
	const live =
		existing ??
		newLive(core, exit.taskId, conn.nodeId, row.output_mode, row.task_group_id, row.max_lines, row.max_bytes, {
			groupEnded: await groupEnded(core, row.task_group_id),
		});
	// TaskExit follows all output on the wire; if bytes are missing, the client will resend after a
	// reconnect and send TaskExit again. Record what we have only when complete. A `status` task gets
	// no task.output at all, so there is nothing to wait for (doc/execution-plane.md#输出).
	const complete = row.output_mode === "status" || live.output.end >= exit.outputEnd;
	if (!complete) return conn.close("output incomplete at exit");

	// A status task's byte total comes from task.exit; the other modes already received the bytes.
	const output = row.output_mode === "status" ? live.output.snapshot(exit.outputEnd) : live.output.snapshot();
	const outcome = exit.outcome;
	const fields: Updateable<TasksTable> = {
		exit_code: outcome.kind === "code" ? outcome.value : null,
		signal: outcome.kind === "signal" ? outcome.value : null,
		error_code: outcome.kind === "error" ? outcome.code : null,
		error_message: outcome.kind === "error" ? outcome.message : null,
		timed_out: exit.timedOut ? 1 : 0,
		cancelled: exit.cancelled ? 1 : 0,
		result: exit.result === null ? null : JSON.stringify(taskResultToJson(exit.result)),
		...outputColumns(output),
		output_lines: exit.outputLines,
		output_file: exit.outputFile || null,
	};
	if (row.state === "unknown") {
		// Already reported as unknown: keep that answer, but record what really happened.
		await writeTask(
			core.db,
			row.id,
			{ states: ["unknown"], nodeId: conn.nodeId },
			{ late_result: JSON.stringify(fields) },
		);
	} else if (!TERMINAL.has(row.state)) {
		await finish(core, conn.nodeId, row.id, { ...fields, state: outcome.kind === "error" ? "failed" : "exited" });
	}
	dropLive(core, row.id);
	conn.peer.emit("task.exit.ack", { taskId: row.id });
}

// ---- the terminal state and its side effects ----

/**
 * Ends a task: writes its terminal row, then runs the side effects every ending shares (see TaskEnd
 * for the order). Returns whether the row matched: an ending that lost a race is a no-op for
 * everything the caller works on afterwards.
 */
export async function endTask(core: ClusterCore, id: string, end: TaskEnd): Promise<boolean> {
	const { write } = end;
	let updated: boolean;
	if ("insert" in write) {
		await insertTask(core.db, write.insert);
		updated = write.ended;
	} else {
		updated = await writeTerminal(core, id, write.from, write.set, write.nodeId, write.rev, write.outOfTurn);
	}
	if (!updated && !end.always) return false;
	if (end.live === "drop") dropLive(core, id);
	else if (end.live === "keep") keepUnknownOutput(core, id);
	if (end.notify !== false) core.notify(id);
	if (updated) {
		end.afterWrite?.();
		const sync =
			end.group === "row" ? syncGroupOfTask(core, id) : end.group ? syncGroupState(core, end.group) : undefined;
		if (sync) {
			if (end.awaitGroup) await sync;
			else core.background("task group state update failed", sync);
		}
		if (end.onChange !== undefined) core.onChange?.(end.onChange);
		if (end.audit !== false) await auditFinish(core, id);
	}
	return updated;
}

/** The guarded row write of an ending: only a task in one of `from` (on `nodeId`, at `rev`) is written. */
async function writeTerminal(
	core: ClusterCore,
	id: string,
	from: readonly TaskRowState[],
	set: Updateable<TasksTable>,
	nodeId?: string,
	rev?: number,
	outOfTurn?: boolean,
): Promise<boolean> {
	return writeTask(core.db, id, { states: from, nodeId, rev }, { ...set, finished_at: now() }, { outOfTurn });
}

/** The dispatch side's ending: the outcome the node reported, on a task that was sent to it. */
export async function finish(
	core: ClusterCore,
	nodeId: string,
	id: string,
	fields: Updateable<TasksTable>,
): Promise<void> {
	await endTask(core, id, {
		write: { from: ["dispatched", "running"], set: fields, nodeId },
		live: fields.state === "unknown" ? "keep" : "drop",
		always: true,
		group: "row",
		awaitGroup: true,
	});
}

/** The node's answer is unknown (no link, no result): the task ends as `unknown(reason)`. */
export async function markUnknown(core: ClusterCore, id: string, reason: string): Promise<void> {
	const row = await core.row(id);
	if (!row || TERMINAL.has(row.state)) return;
	const output = core.live.get(id)?.output.snapshot() ?? EMPTY_OUTPUT;
	await finish(core, row.node_id, id, {
		state: "unknown",
		error_code: reason,
		error_message: "execution status unknown",
		...outputColumns(output),
	});
}

/** Updates a task only from the states the caller has observed (and at `rev`, when it read the row). */
export async function updateTask(
	core: ClusterCore,
	id: string,
	from: readonly TaskRowState[],
	set: Updateable<TasksTable>,
	rev?: number,
): Promise<boolean> {
	const updated = await writeTask(core.db, id, { states: from, rev }, set);
	if (!updated) return false;
	core.notify(id);
	return true;
}

// ---- task groups ----

/**
 * A task group shows awaiting_authorization while every unfinished task of it waits for a signature,
 * and running otherwise (doc/execution-plane.md#状态机). The group's own end states are left alone.
 */
export async function syncGroupState(core: ClusterCore, groupId: string | null): Promise<void> {
	if (!groupId) return;
	const group = await core.db.selectFrom("task_groups").select("state").where("id", "=", groupId).executeTakeFirst();
	if (!group || (group.state !== "running" && group.state !== "awaiting_authorization")) return;
	const rows = await core.db.selectFrom("tasks").select("state").where("task_group_id", "=", groupId).execute();
	const unfinished = rows.filter((row) => !TERMINAL.has(row.state));
	const next =
		unfinished.length > 0 && unfinished.every((row) => row.state === "awaiting_authorization")
			? "awaiting_authorization"
			: "running";
	if (next === group.state) return;
	await core.db
		.updateTable("task_groups")
		.set({ state: next })
		.where("id", "=", groupId)
		.where("state", "=", group.state)
		.execute();
}

/** Re-derives the state of the task's group after the task settled. */
async function syncGroupOfTask(core: ClusterCore, id: string): Promise<void> {
	const row = await core.db.selectFrom("tasks").select("task_group_id").where("id", "=", id).executeTakeFirst();
	if (row?.task_group_id) await syncGroupState(core, row.task_group_id);
}

/** Whether the task's group already ended, so none of its members may run any more. */
export async function groupEnded(core: ClusterCore, groupId: string | null): Promise<boolean> {
	if (!groupId) return false;
	const group = await core.db.selectFrom("task_groups").select("state").where("id", "=", groupId).executeTakeFirst();
	return group !== undefined && GROUP_TERMINAL.has(group.state);
}

// ---- the audits of a task's end ----

/** task.finished: the outcome, as recorded. A cancellation names the actor who asked for it. */
async function auditFinish(core: ClusterCore, id: string): Promise<void> {
	const cancelledBy = core.cancelledBy.get(id);
	core.cancelledBy.delete(id);
	if (!core.audit) return;
	const row = await core.row(id);
	if (!row) return;
	const outputHash = createHash("sha256")
		.update(`${row.output_head ?? ""}\n${row.output_tail ?? ""}`)
		.digest("hex");
	core.auditLater({
		actor:
			cancelledBy && row.cancelled === 1
				? auditActor(cancelledBy)
				: { type: "system", id: "cluster", onBehalfOfUserId: row.on_behalf_of_user_id },
		action: "task.finished",
		target: { type: "task", id },
		detail: {
			node_id: row.node_id,
			state: row.state,
			exit_code: row.exit_code,
			signal: row.signal,
			error_code: row.error_code,
			timed_out: row.timed_out === 1,
			cancelled: row.cancelled === 1,
			output_bytes: Number(row.output_bytes),
			// Of the kept head and tail; crhs never has the full output.
			kept_output_sha256: outputHash,
			output_file: row.output_file,
		},
	});
}

export function auditActor(actor: Actor) {
	return { type: actor.type, id: actor.id, onBehalfOfUserId: actor.onBehalfOfUserId };
}

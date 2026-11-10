/**
 * A task's start on a client node (doc/design/protocol.md "task.start"): the task.start frame built from the row,
 * the input a waiting task keeps on its row, and the one send of task.start with its input chunks that
 * the plain and the authorized dispatch share.
 */
import {
	ConnectionError,
	ProtocolError,
	RemoteError,
	RequestTimeoutError,
	type TaskSpec,
	type TaskStart,
} from "@crh/protocol";
import type { Selectable, Updateable } from "kysely";
import type { TasksTable } from "../storage/schema.ts";
import type { NodeConnection } from "./connection.ts";
import type { ClusterCore } from "./core.ts";
import { OUTPUT_KEEP_BYTES, OUTPUT_KEEP_LINES } from "./output.ts";
import { cancelledTaskFields, finish, onAccepted } from "./task-end.ts";
import { AUTHORIZATION_CODES, TASK_CANCELLED_CODE } from "./types.ts";

/** What tells one dispatch path's task.start from another's; everything else comes from the row. */
interface TaskStartOptions {
	/** The encoded authorizations to attach, in wire order; none for a plain start. */
	authorizations?: readonly Uint8Array[];
	privileged: boolean;
	/** Defaults to the row's attempt (1 when there is no row). */
	attempt?: number;
	/** Defaults to the row's timeout, or 0 when there is none. */
	timeoutMs?: number;
}

/**
 * The task.start frame of a task (doc/design/protocol.md "task.start"), built from the task's row. The row
 * carries the attempt, the timeout and the output mode; the caller says which authorizations ride
 * along, whether the task is privileged and, when it is not the row's, which attempt and timeout.
 */
export function taskStartOf(
	id: string,
	row: Selectable<TasksTable> | undefined,
	spec: TaskSpec,
	options: TaskStartOptions,
): TaskStart {
	return {
		taskId: id,
		attempt: options.attempt ?? row?.attempt ?? 1,
		spec,
		privileged: options.privileged,
		authorizations: [...(options.authorizations ?? [])],
		timeoutMs: options.timeoutMs ?? row?.timeout_ms ?? 0,
		killGraceMs: 0,
		output: outputModeOf(row),
	};
}

/** The wire output mode of a task row (doc/design/protocol.md "task.start"). */
function outputModeOf(row: Selectable<TasksTable> | undefined): TaskStart["output"] {
	const mode = row?.output_mode ?? "full";
	// A `head` task keeps the head of what the node pushes: that is the node's full mode, which streams
	// both streams separately, with crhs doing the budgeted keeping (doc/design/execution.md "Output").
	if (mode === "head") {
		return { kind: "full", spillBytes: OUTPUT_KEEP_BYTES, spillLines: OUTPUT_KEEP_LINES };
	}
	if (mode !== "full") return { kind: mode };
	// A single task's full-mode spill thresholds follow its own budget: when the tail given to the
	// model is truncated, the node keeps the whole output. The wire values may not exceed the defaults.
	return {
		kind: "full",
		spillBytes: cap(row?.max_bytes, OUTPUT_KEEP_BYTES),
		spillLines: cap(row?.max_lines, OUTPUT_KEEP_LINES),
	};
}

/** The row's value when set, never above the default. */
function cap(value: number | null | undefined, max: number): number {
	return value === null || value === undefined ? max : Math.min(value, max);
}

/** The input a waiting task or task group keeps in `pending_input` (base64); empty when it has none. */
export function pendingInputOf(row: Pick<{ pending_input: string | null }, "pending_input">): Uint8Array {
	return row.pending_input ? Buffer.from(row.pending_input, "base64") : new Uint8Array(0);
}

/** The `pending_input` column of a task or task group that starts waiting again with this input: null for none. */
export function pendingInputColumn(inputBytes: Uint8Array): string | null {
	return inputBytes.length > 0 ? Buffer.from(inputBytes).toString("base64") : null;
}

/** How one dispatch path follows the answer to its task.start. */
interface StartFollowUp {
	/**
	 * Runs a write that settles the task. The plain dispatch sends from the background and serializes the
	 * write on the task's queue; the authorized dispatch runs it directly.
	 */
	settle: (write: () => Promise<void>) => Promise<void>;
	/**
	 * A retryable authorization rejection (an authorization_* code) before acceptance: nothing ran.
	 * Without this hook such a rejection ends the task `rejected` with the node's code.
	 */
	onAuthorizationRejected?: (err: RemoteError) => Promise<void>;
}

/**
 * Sends `task.start` exactly once, then, once accepted, the input as pipelined `task.input` requests.
 * See doc/design/execution.md "No duplicate execution and authorization retry".
 */
export async function sendTaskStart(
	core: ClusterCore,
	link: { conn: NodeConnection },
	nodeId: string,
	start: TaskStart,
	inputBytes: Uint8Array,
	followUp: StartFollowUp,
): Promise<void> {
	const id = start.taskId;
	// The task was claimed for dispatch, but it may have been cancelled or given up on since then: the
	// last check comes immediately before the frame leaves (doc/design/execution.md "Task cancellation").
	const row = await core.row(id);
	if (row?.state !== "dispatched") return;
	if (row.cancelled === 1) {
		await followUp.settle(() => finish(core, nodeId, id, cancelledTaskFields()));
		return;
	}
	// task.start waits for the node's answer: it must not be sent from a task queue turn.
	core.assertOutsideTaskTurn("task.start");
	try {
		await link.conn.peer.request("task.start", start);
	} catch (err) {
		if (err instanceof ConnectionError) {
			// The task stays dispatched; the grace timer reports dispatch_unconfirmed, never a retry.
			return;
		}
		if (err instanceof RequestTimeoutError) {
			// The request left, but its answer was lost. The task may have been accepted: never resend.
			// Closing starts the grace timer, which reports dispatch_unconfirmed.
			link.conn.close("task.start timed out");
			return;
		}
		if (err instanceof RemoteError) {
			if (err.code === TASK_CANCELLED_CODE) {
				// The node recorded the cancel of this id before it knew the task: nothing ran.
				await followUp.settle(() => finish(core, nodeId, id, cancelledTaskFields()));
				return;
			}
			const authorization = AUTHORIZATION_CODES.has(err.code);
			if (authorization && followUp.onAuthorizationRejected) {
				await followUp.onAuthorizationRejected(err);
				return;
			}
			const final: Updateable<TasksTable> = authorization
				? { state: "rejected", error_code: err.code, error_message: err.message }
				: { state: "failed", error_code: err.code, error_message: err.message };
			await followUp.settle(() => finish(core, nodeId, id, final));
			return;
		}
		if (err instanceof ProtocolError) {
			// Raised locally while encoding: the request was never sent, so nothing can have run.
			await followUp.settle(() =>
				finish(core, nodeId, id, { state: "failed", error_code: "invalid_spec", error_message: err.message }),
			);
			return;
		}
		console.error("task.start failed:", err);
		link.conn.close("send failed");
		return;
	}
	await followUp.settle(() => onAccepted(core, nodeId, id));
	// Pipelined: crha processes the chunks in order; a failed chunk fails the task on its side.
	for (let off = 0; off < inputBytes.length; off += core.chunkBytes) {
		const data = inputBytes.subarray(off, off + core.chunkBytes);
		void link.conn.peer
			.request("task.input", { taskId: id, offset: off, data })
			.catch((err: unknown) => console.error(`task.input for ${id} failed:`, err));
	}
}

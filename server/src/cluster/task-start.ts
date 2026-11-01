import type { TaskSpec, TaskStart } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { OutputMode, TasksTable } from "../storage/schema.ts";
import { OUTPUT_KEEP_BYTES, OUTPUT_KEEP_LINES } from "./output.ts";

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
 * The task.start frame of a task (doc/protocol.md#taskstart), built from the task's row. The row
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
		output: outputModeOf(row?.output_mode ?? "full"),
	};
}

/** The wire output mode of a task row (doc/protocol.md#taskstart). */
function outputModeOf(mode: OutputMode): TaskStart["output"] {
	// A `head` task keeps the head of what the node pushes: that is the node's full mode, which streams
	// both streams separately, with crhs doing the budgeted keeping (doc/execution-plane.md#输出).
	return mode === "full" || mode === "head"
		? { kind: "full", spillBytes: OUTPUT_KEEP_BYTES, spillLines: OUTPUT_KEEP_LINES }
		: { kind: mode };
}

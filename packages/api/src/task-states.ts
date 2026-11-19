/**
 * The task states in which a task no longer runs, shared by the server and the WebUI (doc/design/execution.md
 * "State machine"). They are runtime values, so this module has no runtime dependency: the WebUI bundles it
 * without zod.
 *
 * `unknown` is terminal for display: whether the command finished is not known, so the task is never shown as
 * running. It is not recorded, though: the server still accepts a late result for it, so a surface that follows
 * a result keeps asking, slowly, for as long as the task stays unknown.
 */
import type { z } from "zod";
import type { TaskStateSchema } from "./schemas/task-state.ts";

/** One value of the task state vocabulary. */
export type TaskStateName = z.infer<typeof TaskStateSchema>;

/** The task states in which no task runs any more. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskStateName> = new Set([
	"exited",
	"errored",
	"rejected",
	"cancelled",
	"expired",
	"unknown",
	"denied",
]);

/** The terminal states that already carry their result; `unknown` still waits for a late one. */
export const RECORDED_TASK_STATES: ReadonlySet<TaskStateName> = new Set([
	"exited",
	"errored",
	"rejected",
	"cancelled",
	"expired",
	"denied",
]);

/** Whether the task no longer runs, `unknown` included. */
export function isTerminalTaskState(state: string): boolean {
	return TERMINAL_TASK_STATES.has(state as TaskStateName);
}

/** Whether the task's result is final (recorded); `unknown` is not, so a late result may still arrive. */
export function isRecordedTaskState(state: string): boolean {
	return RECORDED_TASK_STATES.has(state as TaskStateName);
}

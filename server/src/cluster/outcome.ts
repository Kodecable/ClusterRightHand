/**
 * The one classification of a task's or a task group's terminal result (doc/design/execution.md "State
 * machine"): every surface, and the model-facing task text, reads this function instead of deciding again
 * whether an exit code, signal, timeout, cancellation, rejection, denial or platform error means failure.
 *
 * Priority when several flags hold: cancelled > timed out > signal > rejected/denied > platform error >
 * unknown > exit code. A cancellation is not a failure (it is muted); a rejected or denied request is.
 * Exit 0 succeeds, and an exec task keeps its code in the outcome ("Exit code 0") while a file operation
 * simply reads "Done". `null` means the task is not terminal yet.
 */
import type { TaskOutcome } from "@crh/api";

import type { TaskGroupState, TaskState } from "../storage/schema.ts";
import { GROUP_TERMINAL, TASK_CANCELLED_CODE, TERMINAL } from "./types.ts";

/** The stored fields the classification reads; a TaskView has all of them. */
export interface TaskOutcomeInput {
	kind: string;
	state: TaskState;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	errorCode: string | null;
	errorMessage: string | null;
}

export function taskOutcome(task: TaskOutcomeInput): TaskOutcome | null {
	if (!TERMINAL.has(task.state)) return null;
	// A wait ended by a stopped session or a cancel is written as rejected with the cancel code, not always
	// with the flag: it is still a cancel, which is no failure.
	if (task.cancelled || task.errorCode === TASK_CANCELLED_CODE) return { kind: "cancelled", failed: false };
	if (task.timedOut) return { kind: "timed_out", failed: true };
	if (task.signal !== null && task.signal !== "") return { kind: "signal", signal: task.signal, failed: true };
	if (task.state === "rejected") {
		return {
			kind: "rejected",
			failed: true,
			...(task.errorCode === null ? {} : { errorCode: task.errorCode }),
			...(task.errorMessage === null ? {} : { errorMessage: task.errorMessage }),
		};
	}
	if (task.state === "denied") {
		return {
			kind: "denied",
			failed: true,
			...(task.errorCode === null ? {} : { errorCode: task.errorCode }),
			...(task.errorMessage === null ? {} : { errorMessage: task.errorMessage }),
		};
	}
	if (task.errorCode !== null) {
		return { kind: "error", failed: true, errorCode: task.errorCode, errorMessage: task.errorMessage };
	}
	if (task.state === "unknown") return { kind: "unknown", failed: true };
	if (task.exitCode !== null) {
		// A file operation has no meaningful exit code: exit 0 is simply success. An exec task keeps its
		// code, so its line reads "Exit code 0" rather than "Done".
		if (task.exitCode === 0) {
			return task.kind === "exec"
				? { kind: "succeeded", failed: false, exitCode: 0 }
				: { kind: "succeeded", failed: false };
		}
		return { kind: "exit", failed: true, exitCode: task.exitCode };
	}
	// A terminal row with nothing recorded cannot say what happened; unknowns are not guesses.
	return { kind: "unknown", failed: true };
}

/** The stored fields a task group's view exposes; its members carry their own outcomes. */
export interface TaskGroupOutcomeInput {
	state: TaskGroupState;
	tasks: ReadonlyArray<TaskOutcomeInput & { outcome?: TaskOutcome | null }>;
}

/**
 * A task group's outcome, kept simple: a cancelled group is not a failure, a rejected or interrupted group
 * is, and a finished group fails when any member failed. A group with no members and no failure record has
 * simply succeeded.
 */
export function taskGroupOutcome(group: TaskGroupOutcomeInput): TaskOutcome | null {
	if (!GROUP_TERMINAL.has(group.state)) return null;
	if (group.state === "cancelled") return { kind: "cancelled", failed: false };
	if (group.state === "rejected") return { kind: "rejected", failed: true };
	if (group.state === "interrupted") {
		return { kind: "error", failed: true, errorCode: "interrupted", errorMessage: null };
	}
	const failed = group.tasks.some((task) => (task.outcome ?? taskOutcome(task))?.failed === true);
	return failed
		? { kind: "error", failed: true, errorCode: null, errorMessage: null }
		: { kind: "succeeded", failed: false };
}

/**
 * The one classification of a task's or a task group's terminal result (doc/design/execution.md "State
 * machine"): every surface, and the model-facing task text, reads this function instead of deciding again
 * whether an exit code, signal, timeout, cancellation, an expired signature wait, rejection, denial or
 * platform error means failure.
 *
 * Priority when several flags hold: cancelled/expired > unknown > timed out > signal > rejected/denied >
 * platform error > exit code. An unknown row keeps the recorded unknown answer over any later flags: the
 * node may report an exit code, a signal or a timeout afterward, but the classification does not change.
 * A cancellation or an expired signature wait is not a failure (it is muted); a rejected or denied
 * request is. Exit 0 succeeds, and an exec task keeps its code in the outcome ("Exit code 0") while a file
 * operation simply reads "Done". `null` means the task is not terminal yet.
 */
import type { TaskOutcome } from "@crh/api";

import type { TaskGroupState, TaskState } from "../storage/schema.ts";
import { GROUP_TERMINAL, TERMINAL } from "./types.ts";

/** The stored fields the classification reads; a TaskView has all of them. */
export interface TaskOutcomeInput {
	kind: string;
	state: TaskState;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	errorCode: string | null;
	errorMessage: string | null;
}

export function taskOutcome(task: TaskOutcomeInput): TaskOutcome | null {
	if (!TERMINAL.has(task.state)) return null;
	// The state carries the cancellation and the expired signature wait; neither is a failure.
	if (task.state === "cancelled") return { kind: "cancelled", failed: false };
	if (task.state === "expired") {
		return {
			kind: "expired",
			failed: false,
			...(task.errorCode === null ? {} : { errorCode: task.errorCode }),
			...(task.errorMessage === null ? {} : { errorMessage: task.errorMessage }),
		};
	}
	// The recorded unknown answer wins over flags a late result filled in later.
	if (task.state === "unknown") {
		return task.errorCode === null
			? { kind: "unknown", failed: true }
			: { kind: "error", failed: true, errorCode: task.errorCode, errorMessage: task.errorMessage };
	}
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
	const outcomes = group.tasks.map((task) => task.outcome ?? taskOutcome(task));
	if (outcomes.some((outcome) => outcome?.failed === true)) {
		return { kind: "error", failed: true, errorCode: null, errorMessage: null };
	}
	// A group has no signature wait of its own: its members do, and a member whose wait expired did not run.
	// The group still ends `finished`, but its outcome says why part of it never ran.
	if (outcomes.some((outcome) => outcome?.kind === "expired")) return { kind: "expired", failed: false };
	return { kind: "succeeded", failed: false };
}

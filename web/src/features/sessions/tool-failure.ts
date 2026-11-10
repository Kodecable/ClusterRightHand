import type { TaskGroupView, TaskView } from "@crh/api";
import type { Json, JsonObject } from "./session-events";
import { prettyJson } from "./tool-details";

/**
 * The failure a tool result reports (doc/design/webui.md "Message rendering"): the one badge a tool card shows beyond its call
 * status. It is read from the result `details` or, for a transcript recorded before they existed,
 * from the result JSON, never from a live lookup, so a card keeps the verdict its call had at the time. A
 * result marked `isError` without a task verdict is a failure too.
 *
 * A single task result carries `task_id` and `state`; a task group carries `task_group_id` and `nodes` with one
 * such result per node. The failure rule is the same for both:
 *
 * - `failed`, `denied`, `rejected` and `unknown` are failures;
 * - `exited` is a failure with a non-zero `exit_code`, a `signal`, `timed_out` or `cancelled`, so a
 *   user-cancelled task counts as failed;
 * - anything else (`running`, `dispatched`, `exited` with 0) is not.
 */
export type ToolFailure =
	| {
			kind: "failed";
			reason: "cancelled" | "timed-out" | "signal" | "exit" | "state";
			/** For `reason: "exit"`: the non-zero exit code. */
			exitCode?: number;
	  }
	| { kind: "partly-failed" };

const FAILED_STATES = new Set(["failed", "denied", "rejected", "unknown"]);
const FAILED_GROUP_STATES = new Set(["interrupted", "rejected", "cancelled"]);

/** The failure of one task result (`{ task_id, state, ... }`), or undefined when it did not fail. */
export function taskFailure(value: JsonObject): ToolFailure | undefined {
	const state = typeof value.state === "string" ? value.state : undefined;
	if (state === undefined) return undefined;
	// The explicit flags decide the label before the state, so a cancelled or timed-out run reads as such.
	if (value.cancelled === true) return { kind: "failed", reason: "cancelled" };
	if (value.timed_out === true) return { kind: "failed", reason: "timed-out" };
	if (FAILED_STATES.has(state)) return { kind: "failed", reason: "state" };
	if (state !== "exited") return undefined;
	if (typeof value.signal === "string" && value.signal !== "") return { kind: "failed", reason: "signal" };
	const exitCode = typeof value.exit_code === "number" ? value.exit_code : undefined;
	if (exitCode !== undefined && exitCode !== 0) return { kind: "failed", reason: "exit", exitCode };
	return undefined;
}

/** The failure a returned tool result reports (doc/design/webui.md "Message rendering"), or undefined when it did not fail. */
export function toolResultFailure(result: {
	text: string;
	isError: boolean;
	details: Json | undefined;
}): ToolFailure | undefined {
	// The details carry the same fields as the JSON the old results put in the text. Only a call
	// recorded before that change has no details, so its text is parsed as the fallback.
	const failure =
		result.details === undefined || result.details === null ? toolFailure(result.text) : detailsFailure(result.details);
	if (failure !== undefined) return failure;
	return result.isError ? { kind: "failed", reason: "state" } : undefined;
}

/** The failure of a tool result's details: a single task or a task group, or undefined for no failure. */
export function detailsFailure(details: Json): ToolFailure | undefined {
	if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
	const value = details as JsonObject;
	const nodes = groupNodes(value);
	if (nodes !== undefined) return groupFailure(value, nodes);
	if (typeof value.task_id !== "string") return undefined;
	return taskFailure(value);
}

/** The failure of a tool result's JSON text: a single task or a task group, or undefined for no failure. */
export function toolFailure(text: string): ToolFailure | undefined {
	const parsed = prettyJson(text);
	const value = parsed && !Array.isArray(parsed.value) ? parsed.value : undefined;
	if (!value) return undefined;
	const nodes = groupNodes(value);
	if (nodes !== undefined) return groupFailure(value, nodes);
	if (typeof value.task_id !== "string") return undefined;
	return taskFailure(value);
}

/**
 * The failure of a task view the card followed instead of a result (doc/design/webui.md "Message rendering"): the same
 * meaning as `taskFailure`, read from the stored fields. Only the states that are final can fail.
 */
export function taskViewFailure(task: TaskView): ToolFailure | undefined {
	if (task.cancelled) return { kind: "failed", reason: "cancelled" };
	if (task.timedOut) return { kind: "failed", reason: "timed-out" };
	if (FAILED_STATES.has(task.state)) return { kind: "failed", reason: "state" };
	if (task.state !== "exited") return undefined;
	if (task.signal !== null && task.signal !== "") return { kind: "failed", reason: "signal" };
	const exitCode = task.exitCode;
	if (exitCode !== null && exitCode !== 0) return { kind: "failed", reason: "exit", exitCode };
	return undefined;
}

/** The failure of a task group view: interrupted, rejected or cancelled, or members that partly failed. */
export function taskGroupViewFailure(group: TaskGroupView): ToolFailure | undefined {
	if (FAILED_GROUP_STATES.has(group.state)) return { kind: "failed", reason: "state" };
	const failed = group.tasks.filter((task) => taskViewFailure(task) !== undefined).length;
	if (failed === 0) return undefined;
	return failed === group.tasks.length ? { kind: "failed", reason: "state" } : { kind: "partly-failed" };
}

/** The member results of a task group result; undefined for a single task. */
function groupNodes(value: JsonObject): JsonObject[] | undefined {
	if (typeof value.task_group_id !== "string" || !Array.isArray(value.nodes)) return undefined;
	return value.nodes.filter(
		(node): node is JsonObject => node !== null && typeof node === "object" && !Array.isArray(node),
	);
}

/** Partly failed when some members failed, failed when all did or the group was interrupted, rejected or cancelled. */
function groupFailure(value: JsonObject, nodes: readonly JsonObject[]): ToolFailure | undefined {
	const state = typeof value.state === "string" ? value.state : undefined;
	if (state !== undefined && FAILED_GROUP_STATES.has(state)) return { kind: "failed", reason: "state" };
	const failed = nodes.filter((node) => taskFailure(node) !== undefined).length;
	if (failed === 0) return undefined;
	if (failed === nodes.length) return { kind: "failed", reason: "state" };
	return { kind: "partly-failed" };
}

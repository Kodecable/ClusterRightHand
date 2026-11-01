import type { JsonObject } from "./sessionState";
import { prettyJson } from "./sessionState";

/**
 * The failure a tool result reports (doc/webui.md#工具卡片): the one badge a tool card shows beyond its call
 * status. It is read from the result JSON as the tool returned it, never from a live lookup, so a card keeps the
 * verdict its call had at the time.
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
const FAILED_GROUP_STATES = new Set(["interrupted", "rejected"]);

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

/** The member results of a task group result; undefined for a single task. */
function groupNodes(value: JsonObject): JsonObject[] | undefined {
	if (typeof value.task_group_id !== "string" || !Array.isArray(value.nodes)) return undefined;
	return value.nodes.filter(
		(node): node is JsonObject => node !== null && typeof node === "object" && !Array.isArray(node),
	);
}

/** Partly failed when some members failed, failed when all did or the group was interrupted or rejected. */
function groupFailure(value: JsonObject, nodes: readonly JsonObject[]): ToolFailure | undefined {
	const state = typeof value.state === "string" ? value.state : undefined;
	if (state !== undefined && FAILED_GROUP_STATES.has(state)) return { kind: "failed", reason: "state" };
	const failed = nodes.filter((node) => taskFailure(node) !== undefined).length;
	if (failed === 0) return undefined;
	if (failed === nodes.length) return { kind: "failed", reason: "state" };
	return { kind: "partly-failed" };
}

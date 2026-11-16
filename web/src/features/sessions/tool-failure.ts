import type { TaskGroupView, TaskOutcome, TaskView } from "@crh/api";
import type { Json, JsonObject } from "./session-events";
import { prettyJson } from "./tool-details";

/**
 * The failure a tool result reports (doc/design/webui.md "Message rendering"): the one badge a tool card
 * shows beyond its call status. The server classifies every task result and puts its `outcome` in the result
 * details, so this module only reads that flag; it no longer re-derives exit codes, signals or timeouts.
 *
 * A single task result carries `task_id` and `outcome`; a task group carries `task_group_id`, its own
 * `outcome` and one such result per node. A result marked `isError` without a task outcome is a failure
 * too: that is the non-task failure handling.
 */
export type ToolFailure = { kind: "failed"; outcome: TaskOutcome } | { kind: "partly-failed"; outcome: TaskOutcome };

function isOutcome(value: unknown): value is TaskOutcome {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { kind?: unknown }).kind === "string" &&
		typeof (value as { failed?: unknown }).failed === "boolean"
	);
}

/** The failure of a task's or task group's outcome, or undefined when it did not fail. */
export function outcomeFailure(outcome: TaskOutcome | null | undefined): ToolFailure | undefined {
	if (outcome === null || outcome === undefined || !outcome.failed) return undefined;
	return { kind: "failed", outcome };
}

/** The failure a returned tool result reports, or undefined when it did not fail. */
export function toolResultFailure(result: {
	text: string;
	isError: boolean;
	details: Json | undefined;
}): ToolFailure | undefined {
	// The details carry the server's outcome. Only a call recorded before that field existed has no
	// details, so its text is parsed as the fallback.
	const failure =
		result.details === undefined || result.details === null ? toolFailure(result.text) : detailsFailure(result.details);
	if (failure !== undefined) return failure;
	return result.isError
		? { kind: "failed", outcome: { kind: "error", failed: true, errorCode: null, errorMessage: null } }
		: undefined;
}

/** The task outcome a returned result carries, or undefined when it is not a task result. */
export function toolResultOutcome(result: { text: string; details: Json | undefined }): TaskOutcome | undefined {
	if (result.details !== undefined && result.details !== null) {
		const outcome = detailsOutcome(result.details);
		if (outcome !== undefined) return outcome;
	}
	const parsed = prettyJson(result.text);
	const value = parsed && !Array.isArray(parsed.value) ? parsed.value : undefined;
	if (!value) return undefined;
	return isOutcome(value.outcome) ? value.outcome : undefined;
}

function detailsOutcome(details: Json): TaskOutcome | undefined {
	if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
	return isOutcome((details as JsonObject).outcome) ? ((details as JsonObject).outcome as TaskOutcome) : undefined;
}

/** The failure of a tool result's details: a single task or a task group, or undefined for no failure. */
export function detailsFailure(details: Json): ToolFailure | undefined {
	if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
	const value = details as JsonObject;
	const nodes = groupNodes(value);
	if (nodes !== undefined) return groupFailure(value, nodes);
	if (typeof value.task_id !== "string") return undefined;
	return isOutcome(value.outcome) ? outcomeFailure(value.outcome) : undefined;
}

/** The failure of a tool result's JSON text: a single task or a task group, or undefined for no failure. */
export function toolFailure(text: string): ToolFailure | undefined {
	const parsed = prettyJson(text);
	const value = parsed && !Array.isArray(parsed.value) ? parsed.value : undefined;
	if (!value) return undefined;
	const nodes = groupNodes(value);
	if (nodes !== undefined) return groupFailure(value, nodes);
	if (!isOutcome(value.outcome)) return undefined;
	return outcomeFailure(value.outcome);
}

/** The failure of a task view the card followed instead of a result (doc/design/webui.md "Message rendering"). */
export function taskViewFailure(task: TaskView): ToolFailure | undefined {
	return outcomeFailure(task.outcome);
}

/**
 * The failure of a task group view: a cancelled group is not a failure; a rejected or interrupted group
 * is; a finished group partly failed when some, but not all, members failed.
 */
export function taskGroupViewFailure(group: TaskGroupView): ToolFailure | undefined {
	const failure = outcomeFailure(group.outcome);
	if (failure === undefined) return undefined;
	const failed = group.tasks.filter((task) => task.outcome?.failed === true).length;
	if (group.state === "finished" && failed > 0 && failed < group.tasks.length) {
		return { kind: "partly-failed", outcome: group.outcome as TaskOutcome };
	}
	return failure;
}

/** The member results of a task group result; undefined for a single task. */
function groupNodes(value: JsonObject): JsonObject[] | undefined {
	if (typeof value.task_group_id !== "string" || !Array.isArray(value.nodes)) return undefined;
	return value.nodes.filter(
		(node): node is JsonObject => node !== null && typeof node === "object" && !Array.isArray(node),
	);
}

/** The group's own outcome, partly failed when its members disagree. */
function groupFailure(value: JsonObject, nodes: readonly JsonObject[]): ToolFailure | undefined {
	if (!isOutcome(value.outcome)) return undefined;
	const failure = outcomeFailure(value.outcome);
	if (failure === undefined) return undefined;
	const failed = nodes.filter((node) => isOutcome(node.outcome) && node.outcome.failed).length;
	if (value.state === "finished" && failed > 0 && failed < nodes.length) {
		return { kind: "partly-failed", outcome: value.outcome };
	}
	return failure;
}

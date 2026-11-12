/** Pure helpers of a tool call card: its one-line summary, the ids it follows, and whether it may still return. */

import { taskGroupEnded } from "@/features/tasks/api";
import { isTerminal } from "@/lib/task-output";
import type { Json, JsonObject } from "./session-events";
import { prettyJson } from "./tool-details";
import type { TranscriptItem } from "./transcript-items";

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** The first string argument among `keys`, in order; a joined argv array counts as one too. */
function firstString(args: JsonObject, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

function argvLine(args: JsonObject): string | undefined {
	const argv = args.argv;
	if (!Array.isArray(argv) || argv.length === 0) return undefined;
	const parts = argv.filter((part): part is string => typeof part === "string");
	return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The raw node input of a call: the `targets` as given, or a single `node`-style argument. */
function nodeInput(args: JsonObject): string | undefined {
	const targets = Array.isArray(args.targets)
		? args.targets.filter((target): target is string => typeof target === "string" && target.trim() !== "")
		: [];
	if (targets.length > 0) return targets.join(", ");
	return firstString(args, ["node", "nodeId", "node_id"]);
}

/** The main argument of each tool, without the node, status, exit code or option fields. */
const TOOL_SUBJECT_KEYS: Record<string, readonly string[]> = {
	exec: ["cmd", "shell", "command"],
	read_file: ["path", "file"],
	write_file: ["path", "file"],
	edit_file: ["path", "file"],
	list_dir: ["path", "file"],
	stat: ["path", "file"],
	subagent: ["task", "prompt"],
	task_wait: ["task_id", "task_group_id"],
	task_cancel: ["task_id"],
	subagent_wait: ["id"],
	subagent_cancel: ["id"],
	subagent_decide: ["request_id"],
	node_info: [],
};

function toolSubject(name: string, args: JsonObject): string | undefined {
	if (name === "exec") return firstString(args, ["cmd", "shell", "command"]) ?? argvLine(args);
	const keys = TOOL_SUBJECT_KEYS[name];
	if (keys !== undefined) return firstString(args, keys);
	return firstString(args, [
		"request",
		"request_id",
		"session_id",
		"query",
		"url",
		"id",
		"task_id",
		"task_group_id",
		"name",
	]);
}

/**
 * One line for a tool call (doc/design/webui.md "Message rendering"): `name · node · subject`.
 * The node is the raw target input; there is no node segment when the tool has
 * none. The subject is the one argument that identifies the work (command,
 * path, prompt, task id); everything else stays in the dialog.
 */
export function toolLine(name: string, args: JsonObject): string {
	const node = nodeInput(args);
	const subject = toolSubject(name, args);
	const parts = [name];
	if (node !== undefined) parts.push(node);
	if (subject !== undefined && subject !== node) parts.push(subject);
	return parts.join(" · ");
}

/** The id a returned call links from its `details`; an old transcript keeps it in the result JSON. */
export function resultId(item: ToolItem, key: "task_id" | "task_group_id"): string | undefined {
	const fromDetails = detailId(item.result?.details, key);
	if (fromDetails !== undefined) return fromDetails;
	const parsed = prettyJson(item.result?.text ?? "");
	const value = parsed && !Array.isArray(parsed.value) ? parsed.value : undefined;
	const id = value?.[key];
	return typeof id === "string" && id !== "" ? id : undefined;
}

/** A string field of the call's live status details, e.g. the `task_id` the first status published. */
export function detailId(details: Json | undefined, key: "task_id" | "task_group_id"): string | undefined {
	if (details === null || details === undefined || typeof details !== "object" || Array.isArray(details))
		return undefined;
	const value = details[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Whether an unreturned call may still produce a result (doc/design/webui.md "Message rendering"): the session is running or
 * awaiting, and the call's task or task group, when the card knows one, has not ended.
 */
export function callStillOpen({
	sessionActive,
	taskState,
	taskGroupState,
}: {
	sessionActive: boolean;
	taskState: string | undefined;
	taskGroupState: string | undefined;
}): boolean {
	if (!sessionActive) return false;
	if (taskState !== undefined && isTerminal(taskState)) return false;
	if (taskGroupState !== undefined && taskGroupEnded(taskGroupState)) return false;
	return true;
}

/**
 * The live output of a task between dispatch and its recorded end (doc/execution-plane.md#输出): it
 * accumulates in memory, drawing on its group's shared budget, and is written to the row only when the
 * task ends.
 */
import type { OutputMode } from "../storage/schema.ts";
import {
	BATCH_GROUP_BYTES,
	BATCH_GROUP_LINES,
	BATCH_NODE_BYTES,
	BATCH_NODE_LINES,
	createLiveTask,
	GroupBudget,
	type LiveTask,
	type OutputSnapshot,
} from "./batch-output.ts";
import type { ClusterCore } from "./core.ts";

/** A task between dispatch and its recorded end: output accumulates here, not in the database. */
export interface Live {
	id: string;
	nodeId: string;
	/** The task's group, for the shared batch budget; null for a single task. */
	groupId: string | null;
	output: LiveTask;
}

/** No output at all: a task that never ran, or a status task before task.exit names its file. */
export const EMPTY_OUTPUT: OutputSnapshot = {
	outputBytes: 0,
	outputHead: null,
	outputTail: null,
};

/**
 * The live record of a task between dispatch and its recorded end. A `text` or `head` task draws from its
 * group's shared budget. `groupEnded` says the group already ended: the record then gets a budget of its
 * own, because re-creating the group's released budget would leave an entry in the budget map for a late
 * result that no other task shares.
 */
export function newLive(
	core: ClusterCore,
	id: string,
	nodeId: string,
	mode: OutputMode,
	groupId: string | null,
	maxLines: number | null = null,
	maxBytes: number | null = null,
	options: { groupEnded?: boolean } = {},
): Live {
	// `text` and `head` draw from the group's budget; a single task's `full` keeps its own head/tail.
	let budget: GroupBudget | undefined;
	if (mode === "text" || mode === "head") {
		budget =
			options.groupEnded === true
				? ownBudget(maxLines, maxBytes)
				: budgetFor(core, budgetKey(groupId, id), maxLines, maxBytes);
	}
	const limits =
		mode === "full" ? { maxLines: maxLines ?? BATCH_GROUP_LINES, maxBytes: maxBytes ?? BATCH_GROUP_BYTES } : undefined;
	const live: Live = { id, nodeId, groupId, output: createLiveTask(mode, budget, limits) };
	core.live.set(id, live);
	return live;
}

/** The budget of one task that is not shared: it lives only as long as the live record that draws on it. */
function ownBudget(maxLines: number | null, maxBytes: number | null): GroupBudget {
	return new GroupBudget({
		node: { maxLines: maxLines ?? BATCH_NODE_LINES, maxBytes: maxBytes ?? BATCH_NODE_BYTES },
		total: { maxLines: BATCH_GROUP_LINES, maxBytes: BATCH_GROUP_BYTES },
	});
}

/**
 * The group's budget, created from the per-node caps the task group stored (D112). Every member stored
 * the same caps; a later reconnect re-creates the budget from the first member's row.
 */
function budgetFor(core: ClusterCore, key: string, maxLines: number | null, maxBytes: number | null): GroupBudget {
	let budget = core.budgets.get(key);
	if (!budget) {
		budget = ownBudget(maxLines, maxBytes);
		core.budgets.set(key, budget);
	}
	return budget;
}

/** Drops the live record. A group's budget outlives its tasks and goes with releaseGroupBudget. */
export function dropLive(core: ClusterCore, id: string): void {
	const timer = core.unknownTimers.get(id);
	if (timer) {
		clearTimeout(timer);
		core.unknownTimers.delete(id);
	}
	const live = core.live.get(id);
	if (!live) return;
	core.live.delete(id);
	// A text task outside a group has no group end to release its budget.
	if (live.groupId === null) core.budgets.delete(budgetKey(null, live.id));
}

/** Keeps an unknown task's output for a late result, but no longer than UNKNOWN_OUTPUT_KEEP_MS. */
export function keepUnknownOutput(core: ClusterCore, id: string): void {
	if (!core.live.has(id) || core.unknownTimers.has(id)) return;
	core.unknownTimers.set(
		id,
		setTimeout(() => {
			core.unknownTimers.delete(id);
			dropLive(core, id);
		}, core.unknownKeepMs),
	);
}

/** The live record of a task if the connection reporting it owns the task. */
export function ownLive(core: ClusterCore, nodeId: string, taskId: string): Live | undefined {
	const live = core.live.get(taskId);
	return live?.nodeId === nodeId ? live : undefined;
}

/**
 * Releases the output budget a batch `text` group shares. TaskGroups calls this when the group itself is
 * done (finished, interrupted or rejected), not when its last task ends: with `parallel: 1` every node
 * would otherwise get a fresh budget. Returns whether a budget was still held.
 */
export function releaseGroupBudget(core: ClusterCore, groupId: string): boolean {
	return core.budgets.delete(groupBudgetKey(groupId));
}

/** A group's budget is shared by its tasks; a single text task (not produced by the code) gets its own. */
function budgetKey(groupId: string | null, taskId: string): string {
	return groupId ? groupBudgetKey(groupId) : `task:${taskId}`;
}

function groupBudgetKey(groupId: string): string {
	return `group:${groupId}`;
}

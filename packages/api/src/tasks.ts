/**
 * Tasks and task groups (doc/execution-plane.md, doc/access-control.md "审批").
 * `TaskResultView` is the protocol's JSON task result, not a copy of it.
 */

import type { JsonFileListEntry, JsonTaskResult } from "@crh/protocol";
import type { TaskAuthorizationView } from "./authorizations.ts";
import type { CursorQuery, RefMap } from "./common.ts";
import type { ApprovalRecord, Operation, RuleRef, TaskGroupApprovalRecord } from "./policy.ts";

export type TaskState =
	| "awaiting_approval"
	| "awaiting_authorization"
	| "denied"
	| "dispatched"
	| "running"
	| "exited"
	| "failed"
	| "rejected"
	| "unknown";

/** How much output crhs keeps for a task (doc/execution-plane.md "输出"). */
export type OutputMode = "full" | "text" | "status" | "head";
/** A task group is a batch, so it chooses between the two batch modes only. */
export type BatchOutputMode = "status" | "text" | "head";

export type TaskGroupState =
	| "awaiting_approval"
	| "awaiting_authorization"
	| "running"
	| "finished"
	| "interrupted"
	| "rejected"
	| "cancelled";

/** One entry of a `file.list` result (doc/protocol.md TaskResult). */
export type FileListEntryView = JsonFileListEntry;

/**
 * A task's structured result, in the JSON form the API serves. Its `kind` is the task kind; the
 * fields are the wire fields in camelCase (doc/protocol.md TaskResult).
 */
export type TaskResultView = JsonTaskResult;

/** The task page's list filters (doc/webui.md#api-约定). */
export interface TaskListQuery extends CursorQuery {
	state?: TaskState;
	actorType?: string;
	nodeId?: string;
	/** Tasks whose requesting user (`onBehalfOfUserId`, the "By" column) is this user. */
	userId?: string;
}

export interface TaskView {
	id: string;
	nodeId: string;
	kind: string;
	/** One line describing what ran: the command line or the path. */
	summary: string;
	/** What authorization rules match on: the rendered argv or the normalized path. */
	operation: Operation | null;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string;
	state: TaskState;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	/** The task's timeout in milliseconds; null when it had none. */
	timeoutMs: number | null;
	errorCode: string | null;
	errorMessage: string | null;
	/** Bytes of the single output stream (D114). */
	outputBytes: number;
	/** The kept head of the output stream; text mode keeps only a tail, so this is "". */
	outputHead: string;
	/** The kept tail of the output stream (a single task's or a batch text node's). */
	outputTail: string;
	/** Lines shown by `outputTail`; a last line without a newline counts. */
	outputTailLines: number;
	/** Total lines of the output; null until the node reports it in task.exit. */
	outputLines: number | null;
	/** crhs's own note about the task (the SSH privileged notice); not part of the output (D114). */
	notice: string | null;
	/** The task's output budget; null is the default for its mode (D112). */
	maxLines: number | null;
	maxBytes: number | null;
	outputFile: string | null;
	/** full for a single task; text, status or head for a batch node (doc/execution-plane.md#输出). */
	outputMode: OutputMode;
	/** Whether this is a privileged task (doc/privilege.md). */
	privileged: boolean;
	/** The authorization plan and its history for a privileged task; null for the others. */
	authorization: TaskAuthorizationView | null;
	/** The task's structured result; null for a kind that reports none and for a task that failed. */
	result: TaskResultView | null;
	createdAt: string;
	finishedAt: string | null;
	taskGroupId: string | null;
	ruleChain: RuleRef[] | null;
	approval: ApprovalRecord | null;
	/** The chain's first session, for grouping approvals by session tree. */
	rootSessionId: string | null;
	/** Who handles a waiting approval; null when it is not waiting. */
	handlerType: "agent" | "user" | null;
	handlerSessionId: string | null;
}

export interface TaskGroupView {
	id: string;
	state: TaskGroupState;
	/** Stored target UUIDs or `_all`; the display names are in `refs`. */
	targets: string[];
	/** Display names for the UUID targets; null means the node or node group was deleted. */
	refs: RefMap;
	nodeIds: string[];
	parallel: number;
	failFast: boolean;
	/** status or text for an exec group; head for a file operation (doc/execution-plane.md#输出). */
	outputMode: BatchOutputMode;
	/** Per-node output caps (D112); null means the defaults, 8KB / 128 lines. */
	nodeMaxLines: number | null;
	nodeMaxBytes: number | null;
	/** Whether the group's tasks are privileged tasks (doc/privilege.md). */
	privileged: boolean;
	skipped: string[];
	tasks: TaskView[];
	createdAt: string;
	finishedAt: string | null;
	/** What runs on each node, for display. */
	summary: string;
	kind: string;
	ruleChain: RuleRef[] | null;
	approval: TaskGroupApprovalRecord | null;
	actorType: string;
	actorId: string;
	onBehalfOfUserId: string;
	/** What authorization rules match on, the same for every node. */
	operation: Operation | null;
	/** Root session of the rule chain, for grouping approvals by session tree. */
	rootSessionId: string | null;
	/** Who handles a waiting approval; null when it is not waiting. */
	handlerType: "agent" | "user" | null;
	handlerSessionId: string | null;
}

/** Body of `POST /nodes/:id/tasks` and `POST /task-groups`: `kind` plus the kind's fields. */
export type TaskRequest = {
	kind: string;
	timeoutMs?: number;
	waitMs?: number;
	/** Run as a privileged task (doc/privilege.md). */
	privileged?: boolean;
	maxLines?: number;
	maxBytes?: number;
} & Record<string, unknown>;

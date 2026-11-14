/**
 * Tasks and task groups (doc/design/execution.md, doc/design/access-control.md "Approvals").
 * `TaskResultView` is the protocol's JSON task result, not a copy of it; the view types are derived from
 * their schemas, so the API document and the TypeScript types cannot drift.
 */

import type { JsonFileListEntry, JsonTaskResult } from "@crh/protocol";
import type { z } from "zod";
import type { CursorQuery } from "./common.ts";
import type {
	BatchOutputModeSchema,
	OutputModeSchema,
	TaskGroupStateSchema,
	TaskStateSchema,
} from "./schemas/task-state.ts";
import type { TaskGroupViewSchema, TaskViewSchema } from "./schemas/tasks.ts";

export type TaskState = z.infer<typeof TaskStateSchema>;

/** How much output crhs keeps for a task (doc/design/execution.md "Output"). */
export type OutputMode = z.infer<typeof OutputModeSchema>;
/** A task group is a batch, so it chooses between the two batch modes only. */
export type BatchOutputMode = z.infer<typeof BatchOutputModeSchema>;

export type TaskGroupState = z.infer<typeof TaskGroupStateSchema>;

/** One entry of a `file.list` result (doc/design/protocol.md "Task results"). */
export type FileListEntryView = JsonFileListEntry;

/**
 * A task's structured result, in the JSON form the API serves. Its `kind` is the task kind; the
 * fields are the wire fields in camelCase (doc/design/protocol.md "Task results").
 */
export type TaskResultView = JsonTaskResult;

/** The task page's list filters (doc/design/webui.md "Task and task group pages"). */
export interface TaskListQuery extends CursorQuery {
	state?: TaskState;
	actorType?: string;
	nodeId?: string;
	/** Tasks whose requesting user (`onBehalfOfUserId`, the "By" column) is this user. */
	userId?: string;
	/** Include tasks a dedicated feature created, such as node file browsing (doc/design/execution.md "Task purpose"). */
	includePurpose?: boolean;
}

/** One task, as the task and approval pages show it. */
export type TaskView = z.infer<typeof TaskViewSchema>;

/** One batch: one task per target node (doc/design/agent-runtime.md "Batch execution"). */
export type TaskGroupView = z.infer<typeof TaskGroupViewSchema>;

/** Body of `POST /nodes/:id/tasks` and `POST /task-groups`: `kind` plus the kind's fields. */
export type TaskRequest = {
	kind: string;
	timeoutMs?: number;
	waitMs?: number;
	/** Run as a privileged task (doc/design/privilege.md). */
	privileged?: boolean;
	maxLines?: number;
	maxBytes?: number;
} & Record<string, unknown>;

/**
 * The exec source's waits and renderers (doc/design/jobs.md "Adapters"). `job_wait` must wait and return what
 * `task_wait` did, so the job layer is handed the existing waits and task renderers here instead of importing
 * server/src/tools at runtime.
 */
import type { ExecJobRenderers } from "../jobs/types.ts";
import { execResult, execTaskResult } from "./task-render.ts";
import { waitExistingGroup, waitExistingTask } from "./task-tool.ts";

export const execJobRenderers: ExecJobRenderers = {
	task: (ctx, task, nodeName, transport, privilege, jobId) =>
		execTaskResult(ctx, task, nodeName, transport, privilege, jobId),
	group: (ctx, started, jobId) => execResult(ctx, started, jobId),
	waitTask: async (ctx, id, waitMs) => {
		await waitExistingTask(ctx, id, waitMs);
	},
	waitGroup: async (ctx, id, waitMs) => {
		await waitExistingGroup(ctx, id, waitMs);
	},
};

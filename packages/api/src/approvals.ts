/**
 * The approvals page: waiting approvals, tasks and groups waiting for the
 * caller's signature, and exhausted quotas (doc/design/webui.md "Approvals page").
 */

import type { QuotaApproval } from "./sessions.ts";
import type { TaskGroupView, TaskView } from "./tasks.ts";

export interface ApprovalList {
	tasks: TaskView[];
	taskGroups: TaskGroupView[];
	authorizations: { tasks: TaskView[]; taskGroups: TaskGroupView[] };
	quotas: QuotaApproval[];
}

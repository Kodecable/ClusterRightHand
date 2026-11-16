import type { TaskGroupView, TaskView } from "@crh/api";

/** What a signature wait is about: one task or one task group. */
export type ApprovalItem = { kind: "task"; task: TaskView } | { kind: "task_group"; taskGroup: TaskGroupView };

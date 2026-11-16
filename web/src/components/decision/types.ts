import type { ExternalCallView, TaskGroupView, TaskView } from "@crh/api";

/** What a rule approval or a signature wait is about: one task or one task group. */
export type ApprovalItem = { kind: "task"; task: TaskView } | { kind: "task_group"; taskGroup: TaskGroupView };

/**
 * What the one approval panel decides (doc/design/webui.md "Shared components"): a task, a task group or
 * one external call. The signature wait keeps {@link ApprovalItem}, which has no external call.
 */
export type ApprovalDecisionItem = ApprovalItem | { kind: "external_call"; call: ExternalCallView };

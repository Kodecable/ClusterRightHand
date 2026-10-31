import type { ApprovalList } from "@/lib/api/types";

/**
 * What the Approvals badge and the approvals page count as pending: the
 * requests this user must approve, the tasks and task groups waiting for their
 * signature, and roots whose token quota is used up. A waiting task group is
 * one entry, not one per member task (doc/privilege.md).
 */
export interface PendingLists {
	tasks: readonly unknown[];
	taskGroups: readonly unknown[];
	authorizations: { tasks: readonly unknown[]; taskGroups: readonly unknown[] };
	quotas: readonly unknown[];
}

export function pendingCount(data: PendingLists | undefined): number {
	if (!data) return 0;
	return (
		data.tasks.length +
		data.taskGroups.length +
		data.authorizations.tasks.length +
		data.authorizations.taskGroups.length +
		data.quotas.length
	);
}

/** A type guard for the API answer, used where the shape arrives untyped. */
export function isApprovalList(value: unknown): value is ApprovalList {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Partial<ApprovalList>;
	return Array.isArray(candidate.tasks) && Array.isArray(candidate.taskGroups) && Array.isArray(candidate.quotas);
}

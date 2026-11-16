/**
 * What the Approvals badge and the approvals page count as pending: the
 * requests this user must approve, the tasks and task groups waiting for their
 * signature, and roots whose token quota is used up. A waiting task group is
 * one entry, not one per member task (doc/design/privilege.md).
 */
export interface PendingLists {
	tasks: readonly PendingItem[];
	taskGroups: readonly PendingItem[];
	externalCalls: readonly PendingItem[];
	authorizations: { tasks: readonly PendingItem[]; taskGroups: readonly PendingItem[] };
	quotas: readonly unknown[];
}

/** A row in one of the pending lists; the server omits `reviewing` rows, and older fixtures have no phase. */
export type PendingItem = Record<string, unknown> & { phase?: string };

/** Items Auto Review is still judging are not user-facing approvals, so they never count. */
function countPending(items: readonly PendingItem[]): number {
	return items.filter((item) => item.phase !== "reviewing").length;
}

export function pendingCount(data: PendingLists | undefined): number {
	if (!data) return 0;
	return (
		countPending(data.tasks) +
		countPending(data.taskGroups) +
		countPending(data.externalCalls) +
		countPending(data.authorizations.tasks) +
		countPending(data.authorizations.taskGroups) +
		data.quotas.length
	);
}

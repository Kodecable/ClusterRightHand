/**
 * What every step of a privileged task's authorization uses: ending a task that could not be
 * authorized, withdrawing an outstanding local request, and the record of a task that asks for nothing
 * any more.
 */
import { ConnectionError, type LocalWithdraw } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { TasksTable } from "../../storage/schema.ts";
import { serializeTaskAuthorization, type TaskAuthorizationRecord } from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import type { NodeLink } from "../links.ts";
import { endTask } from "../task-end.ts";

/** The error code of a task a forward node cannot take because its aliases lack a node group the authorization addresses (D110). */
export const ALIAS_MISSING = "alias_missing";

/** A node group a reusable authorization addresses that the node does not trust as an alias (D110). */
export interface MissingAlias {
	groupId: string;
	groupName: string;
}

/**
 * The record once nothing is asked for the task any more: no pending payload and no local request. The
 * stamp is renewed, unless `keepStamp` says to keep the one the record was read with (some endings
 * store it that way).
 */
export function withoutRequests(
	record: TaskAuthorizationRecord,
	options: { keepStamp?: boolean } = {},
): TaskAuthorizationRecord {
	return options.keepStamp
		? { ...record, pending: null, local: null }
		: { ...record, pending: null, local: null, updatedAt: new Date().toISOString() };
}

/** Withdraws a pending local request (the owner signed, the task was cancelled or re-planned). */
export function withdrawLocal(
	link: NodeLink | undefined,
	taskId: string,
	record: TaskAuthorizationRecord | null,
): void {
	if (!record?.local || !link || link.conn.closed) return;
	const withdraw: LocalWithdraw = { taskId, attempt: record.local.attempt };
	void link.conn.peer.request("local.withdraw", withdraw).catch((err: unknown) => {
		if (!(err instanceof ConnectionError)) console.error(`local.withdraw for ${taskId} failed:`, err);
	});
}

/** Ends a task that could not be authorized, with the plan and the reason on its record. */
export async function finishAuthorization(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	state: "failed" | "rejected",
	code: string,
	message: string,
	record: TaskAuthorizationRecord | null,
): Promise<void> {
	// Withdraw first, even when the row turns out settled: another path may have claimed the task
	// while its request was still outstanding on the node (doc/privilege.md#本地批准).
	withdrawLocal(core.links.get(row.node_id), id, record);
	await endTask(core, id, {
		write: {
			from: [row.state],
			set: {
				state,
				error_code: code,
				error_message: message,
				...(record ? { authorization: serializeTaskAuthorization(record) } : {}),
				pending_input: null,
				dispatched_at: null,
				handler_type: null,
				handler_session_id: null,
			},
		},
		live: "drop",
		group: row.task_group_id,
		onChange: row.actor_id,
	});
}

/** Ends a waiting task whose node did not become ready within the offline grace (D113). */
export async function finishNodeOffline(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	record: TaskAuthorizationRecord | null,
): Promise<void> {
	await finishAuthorization(core, id, row, "failed", "node_offline", "the node is not connected", record);
}

/**
 * Ends a waiting task that only a node group alias the node lacks stands between it and a reusable
 * authorization (D110), unless local approval can still authorize it (a single task only).
 */
export async function failAliasMissing(
	core: ClusterCore,
	row: Selectable<TasksTable>,
	previous: TaskAuthorizationRecord | null,
	missing: MissingAlias,
): Promise<void> {
	const localUsable = previous?.plan.paths.some((path) => path.path === "local") && row.task_group_id === null;
	if (localUsable) return;
	await finishAuthorization(
		core,
		row.id,
		row,
		"failed",
		ALIAS_MISSING,
		aliasMissingMessage(missing),
		previous ? withoutRequests(previous, { keepStamp: true }) : null,
	);
}

/** The failure line of a group-addressed reusable authorization the node has no alias for (D110). */
export function aliasMissingMessage(group: MissingAlias): string {
	return `this node does not trust node group ${group.groupName} (${group.groupId}) as an alias; add "${group.groupId}" to aliases in privileged.toml on the node, then run the task again`;
}

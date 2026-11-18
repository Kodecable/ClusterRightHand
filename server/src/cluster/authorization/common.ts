/**
 * What every step of a privileged task's authorization uses: ending a task that could not be
 * authorized and the record of a task that asks for nothing any more.
 */
import type { TaskStart } from "@crh/protocol";
import type { Selectable } from "kysely";
import type { TasksTable } from "../../storage/schema.ts";
import { serializeTaskAuthorization, type TaskAuthorizationRecord } from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import { endTask, failNodeOffline } from "../task-end.ts";

/** A claimed privileged task whose task.start may now be sent, outside the turn that claimed it. */
export interface AuthorizedStart {
	nodeId: string;
	start: TaskStart;
	input: Uint8Array;
	record: TaskAuthorizationRecord;
}

/** The error code of a task a forward node cannot take because its aliases lack a node group the authorization addresses. */
export const ALIAS_MISSING = "alias_missing";

/** A node group a reusable authorization addresses that the node does not trust as an alias. */
export interface MissingAlias {
	groupId: string;
	groupName: string;
}

/** The record of a task that never had one. */
export function emptyAuthorizationRecord(attempt: number): TaskAuthorizationRecord {
	return {
		options: [],
		crhsRejected: null,
		rejectedBefore: null,
		dispatchedPath: null,
		payloadId: null,
		attempt,
		trustDigest: null,
		lastRejection: null,
		updatedAt: new Date().toISOString(),
	};
}

/**
 * The record once nothing is asked for the task any more: no options. The stamp is renewed, unless
 * `keepStamp` says to keep the one the record was read with (some endings store it that way).
 */
export function withoutOptions(
	record: TaskAuthorizationRecord,
	options: { keepStamp?: boolean } = {},
): TaskAuthorizationRecord {
	return options.keepStamp
		? { ...record, options: [] }
		: { ...record, options: [], updatedAt: new Date().toISOString() };
}

/** Ends a task that could not be authorized, with the plan and the reason on its record. Callers run this in a turn of the task's queue; returns whether the row matched. */
export async function finishAuthorization(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	state: "errored" | "rejected" | "expired",
	code: string,
	message: string,
	record: TaskAuthorizationRecord | null,
): Promise<boolean> {
	return endTask(core, id, {
		write: {
			from: [row.state],
			rev: row.rev,
			set: {
				state,
				error_code: code,
				error_message: message,
				...(record ? { authorization: serializeTaskAuthorization({ ...record, options: [] }) } : {}),
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

/**
 * Ends a waiting task whose node did not become ready within the offline grace, keeping the
 * record it was waiting on.
 */
export async function finishNodeOffline(
	core: ClusterCore,
	id: string,
	row: Selectable<TasksTable>,
	record: TaskAuthorizationRecord | null,
): Promise<void> {
	await failNodeOffline(core, id, {
		from: [row.state],
		row,
		live: "drop",
		set: {
			dispatched_at: null,
			...(record ? { authorization: serializeTaskAuthorization({ ...record, options: [] }) } : {}),
		},
	});
}

/** The failure line of a group-addressed reusable authorization the node has no alias for. */
export function aliasMissingMessage(group: MissingAlias): string {
	return `this node does not trust node group ${group.groupName} (${group.groupId}) as an alias; add "${group.groupId}" to aliases in privileged.toml on the node, then run the task again`;
}

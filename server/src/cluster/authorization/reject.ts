/**
 * Rejecting a signature wait (doc/design/privilege.md "Waiting for signatures"): the owner declines to
 * sign, so the waiting task ends as `rejected` with `authorization_declined`, like any other
 * authorization that did not go through.
 */
import { parseTaskAuthorization } from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import type { Actor } from "../types.ts";
import { finishAuthorization } from "./common.ts";

/**
 * The error code of a wait its owner rejected. It is not crha's `authorization_rejected`, so a task the
 * owner turned down is never mistaken for one the node refused.
 */
export const AUTHORIZATION_DECLINED = "authorization_declined";

/** What a task says when its owner rejected the wait without giving a reason. */
export const AUTHORIZATION_REJECTED_MESSAGE = "the owner rejected the authorization";

/** The reason stored on the task: the owner's trimmed reason, or the default when it is empty. */
export function rejectionMessage(reason: string): string {
	const trimmed = reason.trim();
	return trimmed === "" ? AUTHORIZATION_REJECTED_MESSAGE : trimmed;
}

/**
 * Ends a task waiting for its owner's authorization as `authorization_declined`. Runs in the task's turn on
 * a fresh read; returns false when the task is no longer waiting. `options.audit` is false for a task group's members, whose
 * one event names the group instead.
 */
export async function rejectAuthorizationWait(
	core: ClusterCore,
	id: string,
	reason: string,
	by: Actor,
	options: { audit?: boolean } = {},
): Promise<boolean> {
	const message = rejectionMessage(reason);
	const ended = await core.taskQueue.run(id, async () => {
		const row = await core.row(id);
		if (row?.state !== "awaiting_authorization") return false;
		const record = parseTaskAuthorization(row.authorization);
		return finishAuthorization(
			core,
			id,
			row,
			"rejected",
			AUTHORIZATION_DECLINED,
			message,
			record ? { ...record, options: [] } : null,
		);
	});
	if (ended && options.audit !== false) {
		core.auditLater({
			actor: { type: by.type, id: by.id, onBehalfOfUserId: by.onBehalfOfUserId },
			action: "authorization.rejected",
			target: { type: "task", id },
			detail: { reason: message },
		});
	}
	return ended;
}

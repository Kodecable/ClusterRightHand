/**
 * Rejecting a signature wait (doc/design/privilege.md "Waiting for signatures"): the owner declines to
 * sign, so the waiting task ends as `rejected` with `authorization_rejected`, like any other
 * authorization that did not go through.
 */
import { parseTaskAuthorization } from "../authorization.ts";
import type { ClusterCore } from "../core.ts";
import type { Actor } from "../types.ts";
import { finishAuthorization } from "./common.ts";

/** The error code of a signature wait its owner rejected. */
const AUTHORIZATION_REJECTED = "authorization_rejected";

/** What a task says when its owner rejected the wait without giving a reason. */
export const AUTHORIZATION_REJECTED_MESSAGE = "the owner rejected the authorization";

/** The reason stored on the task: the owner's trimmed reason, or the default when it is empty. */
export function rejectionMessage(reason: string): string {
	const trimmed = reason.trim();
	return trimmed === "" ? AUTHORIZATION_REJECTED_MESSAGE : trimmed;
}

/**
 * Ends a task waiting for its owner's signature as `authorization_rejected`, with an outstanding local
 * request withdrawn like any other ending of the wait. Runs in the task's turn on a fresh read; returns
 * false when the task is no longer waiting. `options.audit` is false for a task group's members, whose
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
		return finishAuthorization(
			core,
			id,
			row,
			"rejected",
			AUTHORIZATION_REJECTED,
			message,
			parseTaskAuthorization(row.authorization),
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

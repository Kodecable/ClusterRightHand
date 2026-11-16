/**
 * The waiting work of an API token (doc/design/access-control.md "Approvals"): the tasks and task groups it started that
 * still wait for approval. Revoking a token and a token's expiry cancel that work the same way; a sweep is
 * idempotent because a later run only finds rows that are still waiting.
 */
import type { Actor, Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { Db } from "../storage/db.ts";

/** Cancels waiting requests through the same path every other cancellation takes. */
async function cancelWaiting(
	cluster: Cluster,
	taskGroups: TaskGroups,
	table: "tasks" | "task_groups",
	rows: readonly { id: string }[],
	reason: string,
	by?: Actor,
): Promise<number> {
	let cancelled = 0;
	for (const { id } of rows) {
		const settled =
			table === "tasks" ? await cluster.cancelTask(id, reason, by) : await taskGroups.cancel(id, reason, by);
		if (settled) cancelled++;
	}
	return cancelled;
}

/**
 * Cancels everything the token started that still waits for approval. Returns how many requests a
 * cancellation settled; a request another path settled first is skipped.
 */
export async function cancelWaitingTokenWork(
	db: Db,
	cluster: Cluster,
	taskGroups: TaskGroups,
	tokenId: string,
	reason: string,
	by?: Actor,
): Promise<number> {
	let cancelled = 0;
	for (const table of ["tasks", "task_groups"] as const) {
		const rows = await db
			.selectFrom(table)
			.select("id")
			.where("state", "=", "awaiting_approval")
			.where("actor_type", "=", "api_token")
			.where("actor_id", "=", tokenId)
			.execute();
		cancelled += await cancelWaiting(cluster, taskGroups, table, rows, reason, by);
	}
	return cancelled;
}

/**
 * Cancels the waiting work of tokens a password change just revoked. A router built without a cluster
 * and task groups (some tests) still revokes the tokens; only this cancellation is skipped there.
 */
export async function cancelRevokedTokenWaits(
	db: Db,
	cluster: Cluster | undefined,
	taskGroups: TaskGroups | undefined,
	tokenIds: readonly string[],
	byUserId: string,
): Promise<void> {
	if (!cluster || !taskGroups || tokenIds.length === 0) return;
	const by: Actor = { type: "user", id: byUserId, onBehalfOfUserId: byUserId };
	const reason = "the API token was revoked";
	for (const tokenId of tokenIds) await cancelWaitingTokenWork(db, cluster, taskGroups, tokenId, reason, by);
}

/**
 * Cancels the waiting work of every token whose expiry has passed and that was not revoked (revocation
 * already cancelled its work). Run by the periodic sweep; a second run after the first settles nothing
 * again, because no waiting row is left. Returns how many requests a cancellation settled.
 */
export async function cancelExpiredTokenWaits(
	db: Db,
	cluster: Cluster,
	taskGroups: TaskGroups,
	now: Date = new Date(),
): Promise<number> {
	const reason = "the API token expired";
	let cancelled = 0;
	for (const table of ["tasks", "task_groups"] as const) {
		// Join the token instead of listing expired ids first: the sweep then reads only the rows it acts on,
		// however many expired tokens have accumulated.
		const rows = await db
			.selectFrom(table)
			.innerJoin("api_tokens", "api_tokens.id", `${table}.actor_id`)
			.select(`${table}.id as id`)
			.where(`${table}.state`, "=", "awaiting_approval")
			.where(`${table}.actor_type`, "=", "api_token")
			.where("api_tokens.expires_at", "is not", null)
			.where("api_tokens.expires_at", "<=", now.toISOString())
			.where("api_tokens.revoked_at", "is", null)
			.execute();
		cancelled += await cancelWaiting(cluster, taskGroups, table, rows, reason);
	}
	return cancelled;
}

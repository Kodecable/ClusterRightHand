/**
 * The waiting work of an API token (doc/design/access-control.md "Approvals"): the tasks and task groups it started that
 * still wait for approval. Revoking a token and a token's expiry end that work the same way; a sweep is
 * idempotent because a later run only finds rows that are still waiting.
 */
import type { ApprovalDecision, Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { Db } from "../storage/db.ts";

/** Rejects a waiting request through the same path every other approval decision takes. */
async function rejectWaiting(
	cluster: Cluster,
	taskGroups: TaskGroups,
	table: "tasks" | "task_groups",
	rows: readonly { id: string }[],
	decision: ApprovalDecision,
): Promise<number> {
	let rejected = 0;
	for (const { id } of rows) {
		const settled = table === "tasks" ? await cluster.decide(id, decision) : await taskGroups.decide(id, decision);
		if (settled) rejected++;
	}
	return rejected;
}

/**
 * Rejects everything the token started that still waits for approval. Returns how many requests a
 * decision settled; a request another path settled first is skipped.
 */
export async function rejectWaitingTokenWork(
	db: Db,
	cluster: Cluster,
	taskGroups: TaskGroups,
	tokenId: string,
	decision: ApprovalDecision,
): Promise<number> {
	let rejected = 0;
	for (const table of ["tasks", "task_groups"] as const) {
		const rows = await db
			.selectFrom(table)
			.select("id")
			.where("state", "=", "awaiting_approval")
			.where("actor_type", "=", "api_token")
			.where("actor_id", "=", tokenId)
			.execute();
		rejected += await rejectWaiting(cluster, taskGroups, table, rows, decision);
	}
	return rejected;
}

/**
 * Rejects the waiting work of tokens a password change just revoked, with the decision the single-token
 * revoke route records. A router built without a cluster and task groups (some tests) still revokes the
 * tokens; only this rejection is skipped there.
 */
export async function rejectRevokedTokenWaits(
	db: Db,
	cluster: Cluster | undefined,
	taskGroups: TaskGroups | undefined,
	tokenIds: readonly string[],
	byUserId: string,
): Promise<void> {
	if (!cluster || !taskGroups || tokenIds.length === 0) return;
	const decision: ApprovalDecision = {
		decision: "rejected",
		by: { type: "user", id: byUserId, onBehalfOfUserId: byUserId },
		at: new Date().toISOString(),
		reason: "the API token was revoked",
	};
	for (const tokenId of tokenIds) await rejectWaitingTokenWork(db, cluster, taskGroups, tokenId, decision);
}

/**
 * Rejects the waiting work of every token whose expiry has passed and that was not revoked (revocation
 * already rejected its work). Run by the periodic sweep; a second run after the first settles nothing
 * again, because no waiting row is left. Returns how many requests a decision settled.
 */
export async function rejectExpiredTokenWaits(
	db: Db,
	cluster: Cluster,
	taskGroups: TaskGroups,
	now: Date = new Date(),
): Promise<number> {
	const decision: ApprovalDecision = {
		decision: "rejected",
		by: { type: "system", id: "api-token-expiry" },
		at: now.toISOString(),
		reason: "the API token expired",
	};
	let rejected = 0;
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
		rejected += await rejectWaiting(cluster, taskGroups, table, rows, decision);
	}
	return rejected;
}

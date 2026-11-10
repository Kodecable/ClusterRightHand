import type { Db } from "../storage/db.ts";

/**
 * Session share helpers (doc/design/access-control.md "Ownership, access grants and sharing"): sessions grant an access level to a user or
 * a user group, and a user reaches a session through the strongest share that covers them. Nodes are not shared
 * any more; their access grants live in cluster/node-access.ts.
 */

/** The user groups the user belongs to; a share to any of them reaches the user. */
export async function userGroupIds(db: Db, userId: string): Promise<string[]> {
	const rows = await db
		.selectFrom("user_group_members")
		.select("user_group_id")
		.where("user_id", "=", userId)
		.execute();
	return rows.map((r) => r.user_group_id);
}

/** The stronger of two access levels; `levels` lists them weakest first (session shares: `view < chat`). */
export function stronger<T extends string>(levels: readonly T[], a: T | undefined, b: T): T {
	return a === undefined || levels.indexOf(b) > levels.indexOf(a) ? b : a;
}

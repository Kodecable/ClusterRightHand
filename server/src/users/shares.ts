import type { Db } from "../storage/db.ts";

/**
 * Share helpers shared by node and session shares (doc/access-control.md#归属与分享): both grant an access
 * level to a user or a user group, and a user reaches a resource through the strongest share that covers them.
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

/**
 * The stronger of two access levels. `levels` lists the levels weakest first: session shares are
 * `view < chat`, node shares are `view < operate`.
 */
export function stronger<T extends string>(levels: readonly T[], a: T | undefined, b: T): T {
	return a === undefined || levels.indexOf(b) > levels.indexOf(a) ? b : a;
}

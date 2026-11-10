import type { Kysely } from "kysely";

/**
 * Name the column for what it holds. `user_group_members.group_id` points at `user_groups.id`, and
 * with node groups and task groups in the schema a bare `group_id` reads as any of the three. Renaming the
 * column keeps the primary key and the user-id index valid: both databases carry them through a column
 * rename, and the constraint keeps its name.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("user_group_members").renameColumn("group_id", "user_group_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("user_group_members").renameColumn("user_group_id", "group_id").execute();
}

import type { Kysely } from "kysely";

/**
 * The shared crhs-side source location of a file plane task group (doc/design/library.md "Copies"):
 * each member task still carries its own transfer id and location, while the group owns the one
 * location all members read, so a node-to-nodes copy can delete its staging file when the group ends.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("task_groups").addColumn("transfer", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("task_groups").dropColumn("transfer").execute();
}

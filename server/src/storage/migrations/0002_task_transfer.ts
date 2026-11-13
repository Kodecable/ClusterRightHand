import type { Kysely } from "kysely";

/**
 * The crhs-side transfer location of a file.push/file.pull task (doc/design/library.md "File plane"):
 * JSON with the transfer id and the location descriptor. It is stored on the row so a transfer
 * waiting for approval survives a restart.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").addColumn("transfer", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("tasks").dropColumn("transfer").execute();
}

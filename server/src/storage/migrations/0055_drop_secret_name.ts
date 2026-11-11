import type { Kysely } from "kysely";

/**
 * Keys are identified by their fingerprint, so a `secrets` row needs no label (doc/design/privilege.md
 * "Authorization signing key"). The column 0052 added is unused; both databases drop it in place, and no
 * index or constraint refers to it, so SQLite needs no table rebuild.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("secrets").dropColumn("name").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("secrets").addColumn("name", "text").execute();
}

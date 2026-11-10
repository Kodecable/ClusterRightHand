import type { Kysely } from "kysely";

/**
 * Authorization revocation is gone (doc/design/privilege.md): an authorization is bounded by its deadline,
 * its one-shot task ids and the node's used list, and an emergency response deletes the trust entry or
 * rotates the key on the node instead of revoking the authorization. The `revoked_at` column is
 * therefore dead and dropped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("authorizations").dropColumn("revoked_at").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("authorizations").addColumn("revoked_at", "text").execute();
}

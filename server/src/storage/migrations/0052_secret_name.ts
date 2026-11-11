import type { Kysely } from "kysely";

/**
 * A non-secret label for a `secrets` row (doc/design/privilege.md "Authorization signing key"): an optional
 * name lets administrators tell crhs's several signing keys apart in the WebUI. The key material stays
 * in `ciphertext`, bound to the row's id and kind as before. Additive, so SQLite needs no table rebuild.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("secrets").addColumn("name", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("secrets").dropColumn("name").execute();
}

import type { Kysely } from "kysely";

/**
 * M4.4: the origins a WebAuthn credential was registered for. crhs re-checks an assertion's
 * `clientDataJSON.origin` against them before accepting it; crha checks its own trust entry's
 * `origins` again, so this list can only reject earlier, never widen access.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("user_credentials").addColumn("origins", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("user_credentials").dropColumn("origins").execute();
}

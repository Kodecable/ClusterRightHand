import { type Kysely, sql } from "kysely";

/**
 * Image cache stored time (doc/design/library.md "Image cache").
 *
 * `stored_at` tells when a cache entry's bytes were written, so a result is restored only while the same
 * bytes stayed cached continuously since the result was produced. Existing rows keep their last use as
 * the stored time. Provider rejection is derived from the transcript instead (doc/design/library.md
 * "view_image"), so it needs no column here.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("image_cache").addColumn("stored_at", "text").execute();
	await sql`update image_cache set stored_at = last_used_at where stored_at is null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("image_cache").dropColumn("stored_at").execute();
}

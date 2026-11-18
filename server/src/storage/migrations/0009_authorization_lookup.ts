import type { Kysely } from "kysely";

/**
 * Indexes for an authorization sync pass's lookup of the owner's stored authorizations
 * (doc/design/privilege.md "Authorization path"): the ones still valid (`deadline` in the future) and the
 * ones stored since the planned task or task group was created (`created_at`), both for one issuer.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("authorizations_issuer_deadline_idx")
		.on("authorizations")
		.columns(["issuer_user_id", "deadline"])
		.execute();
	await db.schema
		.createIndex("authorizations_issuer_created_idx")
		.on("authorizations")
		.columns(["issuer_user_id", "created_at"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("authorizations_issuer_created_idx").execute();
	await db.schema.dropIndex("authorizations_issuer_deadline_idx").execute();
}

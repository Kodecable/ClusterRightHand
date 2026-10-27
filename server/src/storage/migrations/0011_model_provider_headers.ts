import type { Kysely } from "kysely";

/**
 * Extra HTTP headers for an OpenAI-compatible endpoint, e.g. a gateway's routing header
 * (opencode zen requires `x-opencode-session`). Not for credentials: those are the encrypted API key.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("model_providers").addColumn("headers", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("model_providers").dropColumn("headers").execute();
}

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("server_meta")
		.addColumn("key", "text", (c) => c.primaryKey())
		.addColumn("value", "text", (c) => c.notNull())
		.execute();

	await db.schema
		.createTable("secrets")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("ciphertext", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute();
	await db.schema.createIndex("secrets_kind_idx").on("secrets").column("kind").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("secrets").execute();
	await db.schema.dropTable("server_meta").execute();
}

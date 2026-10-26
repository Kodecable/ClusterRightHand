import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("orgs")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute();

	await db.schema
		.createTable("users")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("username", "text", (c) => c.notNull())
		.addColumn("display_name", "text", (c) => c.notNull())
		.addColumn("email", "text")
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("password_hash", "text")
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("users_org_username_unique", ["org_id", "username"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("users").execute();
	await db.schema.dropTable("orgs").execute();
}

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("user_groups")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("source", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("user_groups_org_name_unique", ["org_id", "name"])
		.execute();

	await db.schema
		.createTable("user_group_members")
		.addColumn("group_id", "text", (c) => c.notNull().references("user_groups.id").onDelete("cascade"))
		.addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
		.addColumn("created_at", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("user_group_members_pk", ["group_id", "user_id"])
		.execute();
	await db.schema.createIndex("user_group_members_user_id_idx").on("user_group_members").column("user_id").execute();

	await db.schema
		.createTable("web_sessions")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("token_hash", "text", (c) => c.notNull().unique())
		.addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("expires_at", "text", (c) => c.notNull())
		.addColumn("last_seen_at", "text", (c) => c.notNull())
		.addColumn("ip", "text")
		.addColumn("user_agent", "text")
		.execute();
	await db.schema.createIndex("web_sessions_user_id_idx").on("web_sessions").column("user_id").execute();
	await db.schema.createIndex("web_sessions_expires_at_idx").on("web_sessions").column("expires_at").execute();

	await db.schema
		.createTable("shares")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("resource_type", "text", (c) => c.notNull())
		.addColumn("resource_id", "text", (c) => c.notNull())
		.addColumn("grantee_type", "text", (c) => c.notNull())
		.addColumn("grantee_id", "text", (c) => c.notNull())
		.addColumn("access", "text", (c) => c.notNull())
		.addColumn("created_by_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("shares_resource_grantee_unique", [
			"resource_type",
			"resource_id",
			"grantee_type",
			"grantee_id",
		])
		.execute();
	await db.schema.createIndex("shares_grantee_idx").on("shares").columns(["grantee_type", "grantee_id"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("shares").execute();
	await db.schema.dropTable("web_sessions").execute();
	await db.schema.dropTable("user_group_members").execute();
	await db.schema.dropTable("user_groups").execute();
}

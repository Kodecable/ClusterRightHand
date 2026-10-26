import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("nodes")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("transport", "text", (c) => c.notNull())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("public_key", "text", (c) => c.unique())
		.addColumn("hostname", "text")
		.addColumn("facts", "text")
		.addColumn("client_version", "text")
		.addColumn("privileged_mode", "text")
		.addColumn("last_seen_at", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("approved_at", "text")
		.addColumn("approved_by_user_id", "text", (c) => c.references("users.id"))
		.addUniqueConstraint("nodes_org_name_unique", ["org_id", "name"])
		.execute();
	await db.schema.createIndex("nodes_owner_user_id_idx").on("nodes").column("owner_user_id").execute();

	await db.schema
		.createTable("node_groups")
		.addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
		.addColumn("group_name", "text", (c) => c.notNull())
		.addColumn("refreshed_at", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("node_groups_pk", ["node_id", "group_name"])
		.execute();
	await db.schema.createIndex("node_groups_group_name_idx").on("node_groups").column("group_name").execute();

	await db.schema
		.createTable("enrollment_tokens")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("created_by_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("token_hash", "text", (c) => c.notNull().unique())
		.addColumn("name_hint", "text")
		.addColumn("expires_at", "text", (c) => c.notNull())
		.addColumn("used_at", "text")
		.addColumn("used_by_node_id", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("enrollment_tokens").execute();
	await db.schema.dropTable("node_groups").execute();
	await db.schema.dropTable("nodes").execute();
}

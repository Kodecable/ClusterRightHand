import type { Kysely } from "kysely";

/**
 * The low-frequency runtime settings administrators edit in System settings
 * (doc/guide/reference/crhs-config.md): one row per setting and organization, so the file-import rule
 * can ask per key whether the database already holds a value. The value is validated JSON in its API
 * form; a missing row means "use the default".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("settings")
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("key", "text", (c) => c.notNull())
		.addColumn("value", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addColumn("updated_by_user_id", "text", (c) => c.references("users.id"))
		.addPrimaryKeyConstraint("settings_pk", ["org_id", "key"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("settings").execute();
}

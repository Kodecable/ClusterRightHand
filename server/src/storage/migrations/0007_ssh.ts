import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("ssh_credentials")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("public_key", "text", (c) => c.notNull())
		// The private key lives in `secrets`, encrypted with the master key.
		.addColumn("secret_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute();

	for (const [name, type] of [
		["ssh_host", "text"],
		["ssh_port", "integer"],
		["ssh_user", "text"],
		["ssh_host_key", "text"],
		["ssh_credential_id", "text"],
		["ssh_jumps", "text"],
	] as const) {
		await db.schema.alterTable("nodes").addColumn(name, type).execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const name of ["ssh_jumps", "ssh_credential_id", "ssh_host_key", "ssh_user", "ssh_port", "ssh_host"]) {
		await db.schema.alterTable("nodes").dropColumn(name).execute();
	}
	await db.schema.dropTable("ssh_credentials").execute();
}

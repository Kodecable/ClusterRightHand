import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("api_tokens")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("name", "text", (c) => c.notNull())
		// Hex SHA-256 of the token; the token itself is shown once.
		.addColumn("token_hash", "text", (c) => c.notNull().unique())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("expires_at", "text")
		.addColumn("revoked_at", "text")
		.addColumn("last_used_at", "text")
		.execute();

	// Rules of a rule chain level; roots (session, schedule, api_token) also have a preset.
	await db.schema
		.createTable("rule_sets")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("scope_type", "text", (c) => c.notNull())
		.addColumn("scope_id", "text", (c) => c.notNull())
		.addColumn("preset", "text")
		.addColumn("default_action", "text", (c) => c.notNull())
		.addColumn("rules", "text", (c) => c.notNull())
		.addColumn("budget", "text")
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addUniqueConstraint("rule_sets_scope_unique", ["scope_type", "scope_id"])
		.execute();

	await db.schema
		.createTable("audit_events")
		.addColumn("seq", "integer", (c) => c.primaryKey())
		.addColumn("id", "text", (c) => c.notNull().unique())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("ts", "text", (c) => c.notNull())
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text")
		.addColumn("action", "text", (c) => c.notNull())
		.addColumn("target_type", "text")
		.addColumn("target_id", "text")
		.addColumn("detail", "text", (c) => c.notNull())
		.addColumn("prev_hash", "text", (c) => c.notNull())
		.addColumn("hash", "text", (c) => c.notNull())
		.execute();
	await db.schema
		.createIndex("audit_events_target_idx")
		.on("audit_events")
		.columns(["target_type", "target_id"])
		.execute();
	await db.schema.createIndex("audit_events_user_idx").on("audit_events").column("on_behalf_of_user_id").execute();

	// Approval state lives on the tool call itself (doc/design/access-control.md "Approvals").
	for (const table of ["tasks", "task_groups"]) {
		// JSON [{ type, id }]: the rule chain from the root down; null for a user acting in person.
		await db.schema.alterTable(table).addColumn("rule_chain", "text").execute();
		await db.schema.alterTable(table).addColumn("approval", "text").execute();
		// Base64 input kept only while waiting for approval.
		await db.schema.alterTable(table).addColumn("pending_input", "text").execute();
	}
	// A group waiting for approval has not created its tasks yet, so it keeps what to run.
	await db.schema.alterTable("task_groups").addColumn("spec", "text").execute();
	await db.schema.alterTable("task_groups").addColumn("timeout_ms", "integer").execute();
	await db.schema.createIndex("tasks_state_idx").on("tasks").column("state").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("tasks_state_idx").execute();
	await db.schema.alterTable("task_groups").dropColumn("timeout_ms").execute();
	await db.schema.alterTable("task_groups").dropColumn("spec").execute();
	for (const table of ["tasks", "task_groups"]) {
		for (const col of ["pending_input", "approval", "rule_chain"]) {
			await db.schema.alterTable(table).dropColumn(col).execute();
		}
	}
	await db.schema.dropTable("audit_events").execute();
	await db.schema.dropTable("rule_sets").execute();
	await db.schema.dropTable("api_tokens").execute();
}

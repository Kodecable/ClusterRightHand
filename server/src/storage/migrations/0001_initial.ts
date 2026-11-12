import { type Kysely, type SqlBool, sql } from "kysely";
import { isPostgres } from "../dialect.ts";

/**
 * The initial schema, in the shape the application uses (server/src/storage/schema.ts). It is the only
 * migration: future changes append 0002, 0003, … and are never folded into this one.
 *
 * Self-contained per doc/design/data-model.md "Schema migrations": SQLite and PostgreSQL both get the
 * same tables, constraints and indexes, with dialect branches only where the two require different DDL.
 */
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
		.addColumn("user_group_id", "text", (c) => c.notNull().references("user_groups.id").onDelete("cascade"))
		.addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
		.addColumn("created_at", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("user_group_members_pk", ["user_group_id", "user_id"])
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

	await db.schema
		.createTable("nodes")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
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
		.addColumn("ssh_host", "text")
		.addColumn("ssh_port", "integer")
		.addColumn("ssh_user", "text")
		.addColumn("ssh_host_fingerprint", "text")
		.addColumn("ssh_credential_id", "text")
		.addColumn("ssh_jumps", "text")
		.addColumn("trust_report", "text")
		.addColumn("trust_digest", "text")
		.addColumn("trust_updated_at", "text")
		// Lowercase form of `name`; the application always writes it.
		.addColumn("name_key", "text")
		.addUniqueConstraint("nodes_org_name_unique", ["org_id", "name"])
		.execute();

	await db.schema
		.createTable("node_groups")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("name_key", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addUniqueConstraint("node_groups_org_name_key_unique", ["org_id", "name_key"])
		.execute();

	await db.schema
		.createTable("node_group_members")
		.addColumn("node_group_id", "text", (c) => c.notNull().references("node_groups.id").onDelete("cascade"))
		.addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
		.addPrimaryKeyConstraint("node_group_members_pk", ["node_group_id", "node_id"])
		.execute();
	await db.schema.createIndex("node_group_members_node_id_idx").on("node_group_members").column("node_id").execute();

	await db.schema
		.createIndex("nodes_org_name_key_unique")
		.on("nodes")
		.columns(["org_id", "name_key"])
		.unique()
		.execute();

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
		.addColumn("bound_node_id", "text")
		.execute();

	await db.schema
		.createTable("tasks")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("node_id", "text", (c) => c.notNull())
		.addColumn("task_group_id", "text")
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("spec", "text", (c) => c.notNull())
		.addColumn("input_size", "integer")
		.addColumn("input_sha256", "text")
		.addColumn("privileged", "integer", (c) => c.notNull())
		.addColumn("timeout_ms", "integer")
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("exit_code", "integer")
		.addColumn("signal", "text")
		.addColumn("timed_out", "integer", (c) => c.notNull())
		.addColumn("cancelled", "integer", (c) => c.notNull())
		.addColumn("error_code", "text")
		.addColumn("error_message", "text")
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("dispatched_at", "text")
		.addColumn("accepted_at", "text")
		.addColumn("finished_at", "text")
		.addColumn("output_file", "text")
		.addColumn("late_result", "text")
		.addColumn("rule_chain", "text")
		.addColumn("approval", "text")
		.addColumn("pending_input", "text")
		.addColumn("root_session_id", "text")
		.addColumn("handler_type", "text")
		.addColumn("handler_session_id", "text")
		.addColumn("attempt", "integer", (c) => c.notNull().defaultTo(1))
		.addColumn("output_mode", "text", (c) => c.notNull().defaultTo("full"))
		.addColumn("authorization", "text")
		.addColumn("result", "text")
		.addColumn("max_lines", "integer")
		.addColumn("max_bytes", "integer")
		.addColumn("output_tail", "text")
		.addColumn("output_lines", "integer")
		.addColumn("output_head", "text")
		.addColumn("output_bytes", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("notice", "text")
		.addColumn("rev", "integer", (c) => c.notNull().defaultTo(0))
		.execute();
	await db.schema.createIndex("tasks_node_state_idx").on("tasks").columns(["node_id", "state"]).execute();
	await db.schema.createIndex("tasks_group_idx").on("tasks").column("task_group_id").execute();
	await db.schema.createIndex("tasks_state_idx").on("tasks").column("state").execute();
	await db.schema.createIndex("tasks_finished_at_idx").on("tasks").column("finished_at").execute();
	await db.schema
		.createIndex("tasks_handler_agent_idx")
		.on("tasks")
		.columns(["state", "handler_type", "handler_session_id"])
		.execute();
	await db.schema
		.createIndex("tasks_handler_user_idx")
		.on("tasks")
		.columns(["state", "handler_type", "on_behalf_of_user_id"])
		.execute();
	await db.schema.createIndex("tasks_root_session_idx").on("tasks").column("root_session_id").execute();

	await db.schema
		.createTable("task_groups")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("targets", "text", (c) => c.notNull())
		.addColumn("node_ids", "text", (c) => c.notNull())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("parallel", "integer", (c) => c.notNull())
		.addColumn("fail_fast", "integer", (c) => c.notNull())
		.addColumn("skipped", "text", (c) => c.notNull())
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("finished_at", "text")
		.addColumn("rule_chain", "text")
		.addColumn("approval", "text")
		.addColumn("pending_input", "text")
		.addColumn("spec", "text")
		.addColumn("timeout_ms", "integer")
		.addColumn("root_session_id", "text")
		.addColumn("handler_type", "text")
		.addColumn("handler_session_id", "text")
		.addColumn("output_mode", "text", (c) => c.notNull().defaultTo("text"))
		.addColumn("privileged", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("node_max_lines", "integer")
		.addColumn("node_max_bytes", "integer")
		.execute();
	await db.schema.createIndex("task_groups_finished_at_idx").on("task_groups").column("finished_at").execute();
	await db.schema
		.createIndex("task_groups_handler_agent_idx")
		.on("task_groups")
		.columns(["state", "handler_type", "handler_session_id"])
		.execute();
	await db.schema
		.createIndex("task_groups_handler_user_idx")
		.on("task_groups")
		.columns(["state", "handler_type", "on_behalf_of_user_id"])
		.execute();
	await db.schema.createIndex("task_groups_root_session_idx").on("task_groups").column("root_session_id").execute();

	await db.schema
		.createTable("ssh_credentials")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("public_key", "text", (c) => c.notNull())
		.addColumn("secret_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute();

	await db.schema
		.createTable("api_tokens")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("token_hash", "text", (c) => c.notNull().unique())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("expires_at", "text")
		.addColumn("revoked_at", "text")
		.addColumn("last_used_at", "text")
		.execute();

	await db.schema
		.createTable("rule_sets")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("scope_type", "text", (c) => c.notNull())
		.addColumn("scope_id", "text", (c) => c.notNull())
		.addColumn("rule_preset", "text")
		.addColumn("default_action", "text", (c) => c.notNull())
		.addColumn("rules", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addUniqueConstraint("rule_sets_scope_unique", ["scope_type", "scope_id"])
		.execute();

	await db.schema
		.createTable("audit_events")
		// PostgreSQL needs an identity column where SQLite's integer primary key is a rowid alias.
		.addColumn("seq", isPostgres(db) ? "bigint" : "integer", (c) => c.primaryKey())
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
		.execute();
	if (isPostgres(db)) {
		await sql`alter table audit_events alter column seq add generated by default as identity`.execute(db);
	}
	await db.schema
		.createIndex("audit_events_target_idx")
		.on("audit_events")
		.columns(["target_type", "target_id"])
		.execute();
	await db.schema.createIndex("audit_events_user_idx").on("audit_events").column("on_behalf_of_user_id").execute();
	await db.schema.createIndex("audit_events_ts_idx").on("audit_events").column("ts").execute();

	await db.schema
		.createTable("schedules")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("prompt", "text", (c) => c.notNull())
		.addColumn("model", "text", (c) => c.notNull())
		.addColumn("token_budget", "bigint")
		.addColumn("cron", "text", (c) => c.notNull())
		.addColumn("timezone", "text", (c) => c.notNull())
		.addColumn("catch_up", "integer", (c) => c.notNull())
		.addColumn("enabled", "integer", (c) => c.notNull())
		.addColumn("next_run_at", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.execute();
	await db.schema.createIndex("schedules_owner_idx").on("schedules").columns(["owner_user_id", "created_at"]).execute();
	await db.schema.createIndex("schedules_due_idx").on("schedules").columns(["enabled", "next_run_at"]).execute();

	await db.schema
		.createTable("schedule_runs")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("schedule_id", "text", (c) => c.notNull().references("schedules.id").onDelete("cascade"))
		.addColumn("fire_time", "text", (c) => c.notNull())
		.addColumn("manual", "integer", (c) => c.notNull())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("session_id", "text")
		.addColumn("reason", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("started_at", "text")
		.addColumn("finished_at", "text")
		.execute();
	await db.schema
		.createIndex("schedule_runs_fire_idx")
		.on("schedule_runs")
		.columns(["schedule_id", "fire_time"])
		.unique()
		.execute();
	await db.schema
		.createIndex("schedule_runs_schedule_idx")
		.on("schedule_runs")
		.columns(["schedule_id", "fire_time"])
		.execute();

	// `title_pending` sits next to `title` on SQLite and at the end of the table on PostgreSQL; the
	// two dialects keep their respective layouts.
	let sessions = db.schema
		.createTable("sessions")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("conversation_id", "text", (c) => c.notNull().unique())
		.addColumn("parent_session_id", "text")
		.addColumn("title", "text");
	if (!isPostgres(db)) {
		sessions = sessions.addColumn("title_pending", "integer", (c) => c.notNull().defaultTo(0));
	}
	sessions = sessions
		.addColumn("model", "text", (c) => c.notNull())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addColumn("archived_at", "text")
		.addColumn("budget_used_tokens", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("last_submission_id", "text")
		.addColumn("quota_tokens", "bigint")
		.addColumn("state", "text", (c) => c.notNull().defaultTo("idle"))
		.addColumn("waiting_level_id", "text")
		.addColumn("state_changed_at", "text")
		.addColumn("waiting_handler_id", "text")
		.addColumn("schedule_id", "text", (c) => c.references("schedules.id").onDelete("set null"))
		.addColumn("waiting_kind", "text")
		.addColumn("root_session_id", "text", (c) => c.notNull())
		.addColumn("usage_tokens", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("context_tokens", "bigint");
	if (isPostgres(db)) {
		sessions = sessions.addColumn("title_pending", "integer", (c) => c.notNull().defaultTo(0));
	}
	await sessions
		.addColumn("create_request_id", "text")
		.addColumn("reply_at", "text")
		.addColumn("owner_read_at", "text")
		.addColumn("stat_turns", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("stat_steps", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("stat_ttft_ms", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("stat_ttft_steps", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("stat_decode_ms", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("stat_decode_tokens", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("prompt_tokens", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("cache_read_tokens", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("counted_submission_id", "text")
		.execute();
	await db.schema.createIndex("sessions_owner_idx").on("sessions").columns(["owner_user_id", "created_at"]).execute();
	await db.schema.createIndex("sessions_parent_idx").on("sessions").column("parent_session_id").execute();
	await db.schema
		.createIndex("sessions_waiting_handler_idx")
		.on("sessions")
		.columns(["state", "waiting_handler_id"])
		.execute();
	await db.schema.createIndex("sessions_schedule_idx").on("sessions").column("schedule_id").execute();
	await db.schema
		.createIndex("sessions_owner_parent_updated_idx")
		.on("sessions")
		.columns(["owner_user_id", "parent_session_id", "updated_at", "id"])
		.execute();
	await db.schema
		.createIndex("sessions_parent_updated_idx")
		.on("sessions")
		.columns(["parent_session_id", "updated_at", "id"])
		.execute();
	await db.schema.createIndex("sessions_root_state_idx").on("sessions").columns(["root_session_id", "state"]).execute();
	await db.schema
		.createIndex("sessions_state_live_idx")
		.on("sessions")
		.column("state")
		.where(sql<SqlBool>`state <> 'idle'`)
		.execute();
	await db.schema.createIndex("sessions_last_submission_idx").on("sessions").column("last_submission_id").execute();
	await db.schema
		.createIndex("sessions_owner_create_request_unique")
		.on("sessions")
		.columns(["owner_user_id", "create_request_id"])
		.unique()
		.execute();

	await db.schema
		.createTable("model_providers")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("provider_id", "text", (c) => c.notNull().unique())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("builtin", "text")
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("base_url", "text")
		.addColumn("secret_id", "text")
		.addColumn("models", "text")
		.addColumn("enabled", "integer", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addColumn("headers", "text")
		.addColumn("session_id", "text")
		.execute();

	await db.schema
		.createTable("authorizations")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("payload", "text", (c) => c.notNull())
		.addColumn("signatures", "text", (c) => c.notNull())
		.addColumn("issuer_user_id", "text", (c) => c.references("users.id"))
		.addColumn("task_ids", "text")
		.addColumn("deadline", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.execute();
	await db.schema
		.createIndex("authorizations_org_created_idx")
		.on("authorizations")
		.columns(["org_id", "created_at"])
		.execute();
	await db.schema.createIndex("authorizations_deadline_idx").on("authorizations").column("deadline").execute();

	await db.schema
		.createTable("signing_credentials")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("public_key", "text", (c) => c.notNull())
		.addColumn("fingerprint", "text")
		.addColumn("credential_id", "text")
		.addColumn("rp_id", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("origins", "text")
		.addUniqueConstraint("signing_credentials_user_fingerprint_unique", ["user_id", "fingerprint"])
		.addUniqueConstraint("signing_credentials_user_credential_unique", ["user_id", "credential_id"])
		.execute();
	await db.schema.createIndex("signing_credentials_user_id_idx").on("signing_credentials").column("user_id").execute();

	await db.schema
		.createTable("node_access_grants")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("grantee_type", "text", (c) => c.notNull())
		.addColumn("grantee_id", "text", (c) => c.notNull())
		.addColumn("target_type", "text", (c) => c.notNull())
		.addColumn("target_id", "text", (c) => c.notNull())
		.addColumn("created_by_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("node_access_grants_unique", ["grantee_type", "grantee_id", "target_type", "target_id"])
		.execute();
	await db.schema
		.createIndex("node_access_grants_grantee_idx")
		.on("node_access_grants")
		.columns(["grantee_type", "grantee_id"])
		.execute();
	await db.schema
		.createIndex("node_access_grants_target_idx")
		.on("node_access_grants")
		.columns(["target_type", "target_id"])
		.execute();

	await db.schema
		.createTable("model_presets")
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("model", "text")
		.addColumn("system_prompt", "text")
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addPrimaryKeyConstraint("model_presets_pk", ["org_id", "kind"])
		.execute();

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
	for (const table of [
		"settings",
		"model_presets",
		"node_access_grants",
		"signing_credentials",
		"authorizations",
		"model_providers",
		"sessions",
		"schedule_runs",
		"schedules",
		"audit_events",
		"rule_sets",
		"api_tokens",
		"ssh_credentials",
		"task_groups",
		"tasks",
		"enrollment_tokens",
		"node_group_members",
		"node_groups",
		"nodes",
		"secrets",
		"server_meta",
		"shares",
		"web_sessions",
		"user_group_members",
		"user_groups",
		"users",
		"orgs",
	]) {
		await db.schema.dropTable(table).execute();
	}
}

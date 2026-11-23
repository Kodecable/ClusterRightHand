import { randomBytes } from "node:crypto";
import { type Kysely, type SqlBool, sql } from "kysely";
import { isPostgres } from "../dialect.ts";

/** A UUIDv7 for the seeded rows; kept here so the migration does not depend on code that may change. */
function uuidv7(): string {
	const bytes = randomBytes(16);
	bytes.writeUIntBE(Date.now(), 0, 6);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The initial schema, in the shape the application uses (server/src/storage/schema.ts): the schema of
 * v0.4.0-rc.1. Later changes append 0002, 0003, … and are never folded into this one.
 *
 * Self-contained per doc/design/data-model.md "Schema migrations": SQLite and PostgreSQL both get the
 * same tables, constraints and indexes, with dialect branches only where the two require different DDL.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Byte counts can pass 2^31: `bigint` on PostgreSQL, where `integer` is 32-bit. SQLite's `integer` is
	// already 64-bit. Reads return numbers through the int8 type parser (storage/pg-int8.ts).
	const bytes = isPostgres(db) ? "bigint" : "integer";

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
		.addColumn("input_size", bytes)
		.addColumn("input_sha256", "text")
		.addColumn("privileged", "integer", (c) => c.notNull())
		.addColumn("timeout_ms", "integer")
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("exit_code", "integer")
		.addColumn("signal", "text")
		.addColumn("timed_out", "integer", (c) => c.notNull())
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
		.addColumn("max_bytes", bytes)
		.addColumn("output_tail", "text")
		.addColumn("output_lines", "integer")
		.addColumn("output_head", "text")
		.addColumn("output_bytes", bytes, (c) => c.notNull().defaultTo(0))
		.addColumn("notice", "text")
		.addColumn("rev", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("transfer", "text")
		.addColumn("purpose", "text")
		// The pi-durable tool task of the call that created the work, for Auto Review
		// (doc/design/access-control.md "Auto Review"); null when no tool call created it.
		.addColumn("source_tool_task", "text")
		/** Whether crha lost buffered output before the task exited (doc/design/execution.md "Output"). */
		.addColumn("output_lost", "integer", (c) => c.notNull().defaultTo(0))
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
		.addColumn("node_max_bytes", bytes)
		.addColumn("purpose", "text")
		.addColumn("transfer", "text")
		.addColumn("source_tool_task", "text")
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

	// Chat channels (doc/design/channels.md). `channels` holds one connected chat platform bot, its encrypted
	// credentials (a `secrets` row), `config` (JSON of kind-specific non-secret settings), `link_instructions` and
	// `cursor`, the last platform update handled. `channel_accounts` links one platform account to one CRH user;
	// `channel_link_codes` holds a one-time code's hash; `channel_threads` maps a private chat (and topic) to one
	// session, or to a draft before the first message starts it.
	await db.schema
		.createTable("channels")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("enabled", "integer", (c) => c.notNull())
		/** The `secrets` row holding the credentials JSON, encrypted with the master key. */
		.addColumn("credentials_secret_id", "text")
		/** JSON of kind-specific non-secret settings; a Satori gateway's URL, platform and bot id. */
		.addColumn("config", "text")
		/** Plain text shown to users before they link a chat (seen with a Satori channel). */
		.addColumn("link_instructions", "text")
		/** The last platform update id handled. */
		.addColumn("cursor", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addUniqueConstraint("channels_org_name_unique", ["org_id", "name"])
		.execute();

	await db.schema
		.createTable("channel_accounts")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("channel_id", "text", (c) => c.notNull())
		.addColumn("platform", "text", (c) => c.notNull())
		.addColumn("platform_user_id", "text", (c) => c.notNull())
		/** The private chat to send to; a platform's user id for Telegram. */
		.addColumn("platform_chat_id", "text")
		.addColumn("user_id", "text", (c) => c.notNull())
		.addColumn("display_name", "text")
		/** The platform's latest reported language tag, so pushed messages can follow it when no user locale is set. */
		.addColumn("language_code", "text")
		.addColumn("linked_at", "text", (c) => c.notNull())
		.addUniqueConstraint("channel_accounts_platform_unique", ["channel_id", "platform", "platform_user_id"])
		.execute();
	await db.schema.createIndex("channel_accounts_user_idx").on("channel_accounts").columns(["user_id"]).execute();

	await db.schema
		.createTable("channel_link_codes")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("user_id", "text", (c) => c.notNull())
		/** Hex SHA-256 of the code; the code itself is never stored. */
		.addColumn("code_hash", "text", (c) => c.notNull())
		.addColumn("expires_at", "text", (c) => c.notNull())
		.addColumn("used_at", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("channel_link_codes_hash_unique", ["code_hash"])
		.execute();
	await db.schema.createIndex("channel_link_codes_user_idx").on("channel_link_codes").columns(["user_id"]).execute();

	await db.schema
		.createTable("channel_threads")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("channel_id", "text", (c) => c.notNull())
		.addColumn("platform", "text", (c) => c.notNull())
		.addColumn("chat_id", "text", (c) => c.notNull())
		.addColumn("topic_id", "text")
		/** The session the thread is on; null while the thread holds a draft. */
		.addColumn("session_id", "text")
		/** JSON draft settings (model, rule preset, disabled extensions) before the first message starts a session. */
		.addColumn("draft", "text")
		/** 1 for a chat's current session; platforms with topics keep 0. */
		.addColumn("current", "integer", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.execute();
	await db.schema
		.createIndex("channel_threads_chat_idx")
		.on("channel_threads")
		.columns(["channel_id", "platform", "chat_id", "topic_id"])
		.execute();
	await db.schema.createIndex("channel_threads_session_idx").on("channel_threads").columns(["session_id"]).execute();

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
		.addColumn("report_account_id", "text", (c) => c.references("channel_accounts.id").onDelete("set null"))
		.addColumn("report_on", "text", (c) => c.notNull().defaultTo("always"))
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

	await db.schema
		.createTable("sessions")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("conversation_id", "text", (c) => c.notNull().unique())
		.addColumn("parent_session_id", "text")
		.addColumn("forked_from_session_id", "text")
		.addColumn("forked_from_entry_id", "bigint")
		.addColumn("title", "text")
		.addColumn("title_pending", "integer", (c) => c.notNull().defaultTo(0))
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
		.addColumn("context_tokens", "bigint")
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
		/** JSON list of extension names the owner turned off; a subagent copies its parent's and can only add. */
		.addColumn("disabled_extensions", "text")
		/** Where the latest user message came from: `web`, a `channel_threads.id`, or null (a schedule). */
		.addColumn("last_used_from", "text")
		/** The system prompt assembled at the session's first model request and used for every later one. */
		.addColumn("system_prompt", "text")
		/** How many times completion notices woke the session since the last user-authored message. */
		.addColumn("notice_wakes", "integer", (c) => c.notNull().defaultTo(0))
		/** A root session's todo list as JSON; null when it never had one or the list was cleared. */
		.addColumn("todos", "text")
		/** The todo list frozen when a compaction is planned, so every later request appends the same block. */
		.addColumn("todos_at_compaction", "text")
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
	// An authorization sync pass looks up the owner's valid authorizations and those stored since the work was
	// created (doc/design/privilege.md "Authorization path").
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

	await db.schema
		.createTable("image_cache")
		.addColumn("sha256", "text", (c) => c.primaryKey())
		.addColumn("bytes", bytes, (c) => c.notNull())
		.addColumn("mime", "text", (c) => c.notNull())
		.addColumn("last_used_at", "text", (c) => c.notNull())
		.addColumn("stored_at", "text")
		.execute();
	await db.schema.createIndex("image_cache_last_used_idx").on("image_cache").column("last_used_at").execute();

	// Libraries and their files (doc/design/library.md "Libraries" and "Metadata and objects").
	await db.schema
		.createTable("libraries")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("owner_kind", "text", (c) => c.notNull())
		.addColumn("owner_id", "text", (c) => c.notNull())
		.addColumn("max_files", "integer", (c) => c.notNull())
		.addColumn("max_file_bytes", bytes, (c) => c.notNull())
		.addColumn("max_total_bytes", bytes, (c) => c.notNull())
		.addColumn("used_files", "integer", (c) => c.notNull())
		.addColumn("used_bytes", bytes, (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("libraries_owner_unique", ["owner_kind", "owner_id"])
		.execute();

	await db.schema
		.createTable("library_files")
		.addColumn("library_id", "text", (c) => c.notNull().references("libraries.id").onDelete("cascade"))
		.addColumn("path", "text", (c) => c.notNull())
		.addColumn("size", bytes, (c) => c.notNull())
		.addColumn("sha256", "text", (c) => c.notNull())
		.addColumn("media_type", "text", (c) => c.notNull())
		.addColumn("backend", "text", (c) => c.notNull())
		.addColumn("object_key", "text", (c) => c.notNull())
		.addColumn("created_by", "text")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addUniqueConstraint("library_files_library_path_unique", ["library_id", "path"])
		.execute();
	await db.schema.createIndex("library_files_object_key_idx").on("library_files").column("object_key").execute();

	// The skills of each library (doc/design/library.md "Skills"): one row per `skills/<name>/SKILL.md`.
	await db.schema
		.createTable("library_skills")
		.addColumn("library_id", "text", (c) => c.notNull().references("libraries.id").onDelete("cascade"))
		.addColumn("path", "text", (c) => c.notNull())
		.addColumn("sha256", "text", (c) => c.notNull())
		.addColumn("name", "text")
		.addColumn("description", "text")
		.addColumn("invalid", "text")
		.addUniqueConstraint("library_skills_library_path_unique", ["library_id", "path"])
		.execute();

	// Extensions, their grants and external calls (doc/design/extensions.md). `extensions` holds MCP servers
	// (`kind = 'mcp'`) and crhs's built-ins (`kind = 'builtin'`) in one name namespace; an MCP server's headers
	// are in one `secrets` row. `external_calls` is the small object an external tool approval belongs to; a
	// terminal row keeps its state and clears its arguments.
	await db.schema
		.createTable("extensions")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("description", "text")
		.addColumn("url", "text")
		.addColumn("headers_secret_id", "text")
		.addColumn("identity_headers", "text")
		.addColumn("enabled", "integer", (c) => c.notNull())
		.addColumn("list_directly", "integer", (c) => c.notNull())
		.addColumn("availability", "text", (c) => c.notNull())
		.addColumn("trust_annotations", "integer")
		.addColumn("timeout_ms", "integer")
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		// What an MCP server last reported (doc/design/extensions.md "MCP connections"): crhs connects only
		// when it needs to, so the tool list, the server's own description and the last refresh outlive a
		// connection. Each tool carries the `tools_rev` at which its definition last changed.
		.addColumn("server_instructions", "text")
		.addColumn("server_description", "text")
		.addColumn("tools", "text")
		.addColumn("tools_rev", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("refreshed_at", "text")
		.addColumn("refresh_error", "text")
		// A built-in's settings: JSON `{ values, secrets }` and one `secrets` row with the secret values.
		.addColumn("config", "text")
		.addColumn("config_secret_id", "text")
		.addUniqueConstraint("extensions_org_name_unique", ["org_id", "name"])
		.execute();

	await db.schema
		.createTable("extension_grants")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("extension_id", "text", (c) => c.notNull())
		.addColumn("grantee_type", "text", (c) => c.notNull())
		.addColumn("grantee_id", "text", (c) => c.notNull())
		.addColumn("created_by_user_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("extension_grants_unique", ["extension_id", "grantee_type", "grantee_id"])
		.execute();
	await db.schema
		.createIndex("extension_grants_grantee_idx")
		.on("extension_grants")
		.columns(["grantee_type", "grantee_id"])
		.execute();

	await db.schema
		.createTable("external_calls")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text", (c) => c.notNull())
		.addColumn("extension_name", "text", (c) => c.notNull())
		.addColumn("tool_name", "text", (c) => c.notNull())
		.addColumn("arguments", "text")
		.addColumn("operation", "text", (c) => c.notNull())
		.addColumn("annotations", "text")
		.addColumn("rule_chain", "text")
		.addColumn("approval", "text")
		.addColumn("pending_input", "text")
		.addColumn("root_session_id", "text")
		.addColumn("handler_type", "text")
		.addColumn("handler_session_id", "text")
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("finished_at", "text")
		.addColumn("source_tool_task", "text")
		/** The `tools_rev` the call was judged at, so an approval never carries over to a changed tool. */
		.addColumn("tool_rev", "integer")
		.execute();
	await db.schema
		.createIndex("external_calls_state_idx")
		.on("external_calls")
		.columns(["state", "handler_type"])
		.execute();
	await db.schema
		.createIndex("external_calls_actor_idx")
		.on("external_calls")
		.columns(["actor_type", "actor_id"])
		.execute();

	// Jobs (doc/design/jobs.md "Job model"): one row per tool call that may outlive its invocation. The row
	// is a projection of the task, external call or child session behind it; the adapters read those records
	// and never write them. `call_key` is the durable tool call key, so a replayed tool call finds its job.
	await db.schema
		.createTable("jobs")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text", (c) => c.notNull())
		.addColumn("session_id", "text", (c) => c.references("sessions.id").onDelete("cascade"))
		.addColumn("call_key", "text", (c) => c.notNull().unique())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("resource_type", "text", (c) => c.notNull())
		.addColumn("resource_id", "text", (c) => c.notNull())
		.addColumn("action", "text", (c) => c.notNull())
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("outcome", "text")
		.addColumn("wait", "text")
		.addColumn("result", "text")
		.addColumn("notice", "text", (c) => c.notNull().defaultTo("none"))
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("settled_at", "text")
		.execute();
	await db.schema.createIndex("jobs_session_state_idx").on("jobs").columns(["session_id", "state"]).execute();
	await db.schema.createIndex("jobs_resource_idx").on("jobs").columns(["resource_type", "resource_id"]).execute();

	// One user's preferences; a missing row means the defaults.
	await db.schema
		.createTable("user_settings")
		.addColumn("user_id", "text", (c) => c.primaryKey())
		/** The UI and chat-bot language: `en` or `zh-CN`; null uses the browser's choice. */
		.addColumn("locale", "text")
		/** JSON ModelRef for new sessions, thinking level included; null uses the session model preset. */
		.addColumn("default_model", "text")
		/** RulePreset for new sessions; null means `ask`. */
		.addColumn("default_rule_preset", "text")
		/** 1 shows a progress status/draft in chat while a turn runs. */
		.addColumn("show_progress", "integer", (c) => c.notNull().defaultTo(1))
		/** A linked chat account notifications go to; null means none. FK channel_accounts.id, ON DELETE SET NULL. */
		.addColumn("default_channel_account_id", "text", (c) => c.references("channel_accounts.id").onDelete("set null"))
		.addColumn("updated_at", "text", (c) => c.notNull())
		.execute();

	// The single organization and the built-in extensions exist from the start. A built-in's description is a
	// constant of crhs and is not stored; `crhs-ds-search` is billed per call and needs an API key, so it
	// starts disabled.
	const now = new Date().toISOString();
	const orgId = uuidv7();
	await sql`insert into orgs (id, name, created_at) values (${orgId}, 'default', ${now})`.execute(db);
	for (const [name, enabled] of [
		["crhs-docs", 1],
		["crhs-api", 1],
		["crhs-ds-search", 0],
	] as const) {
		await sql`
			insert into extensions (
				id, org_id, name, kind, description, url, headers_secret_id, identity_headers, enabled,
				list_directly, availability, trust_annotations, timeout_ms, created_at, updated_at
			) values (
				${uuidv7()}, ${orgId}, ${name}, 'builtin', null, null, null, null, ${enabled},
				1, 'everyone', null, null, ${now}, ${now}
			)`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const table of [
		"user_settings",
		"external_calls",
		"jobs",
		"extension_grants",
		"extensions",
		"library_skills",
		"library_files",
		"libraries",
		"image_cache",
		"settings",
		"model_presets",
		"node_access_grants",
		"signing_credentials",
		"authorizations",
		"model_providers",
		"sessions",
		"schedule_runs",
		"schedules",
		"channel_threads",
		"channel_link_codes",
		"channel_accounts",
		"channels",
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

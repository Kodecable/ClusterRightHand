import type { Kysely } from "kysely";

/**
 * MCP servers, their grants and external calls (doc/design/extensions.md).
 *
 * `mcp_servers` holds the administrator's servers; the request headers are in one `secrets` row referenced
 * by `headers_secret_id`, like a model provider's API key. `mcp_server_grants` says which users and user
 * groups may use a server, with the same grantee shape as node access grants.
 *
 * `external_calls` is the small object an external tool approval belongs to: it carries the same rule
 * chain and approval columns as a task, the call's server, tool, arguments and operation. It keeps only
 * the state that must survive while a call is in progress; a terminal row keeps its state and
 * `finished_at` and clears its arguments, because its id derived from the durable tool call is the
 * "already ran" marker. The result lives in the transcript and the decision in the audit log.
 *
 * `sessions.disabled_mcp_servers` is the JSON list of server names the owner turned off for that session;
 * a subagent copies its parent's list at creation and can only add to it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("mcp_servers")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("description", "text")
		.addColumn("url", "text", (c) => c.notNull())
		.addColumn("headers_secret_id", "text")
		.addColumn("identity_headers", "text")
		.addColumn("enabled", "integer", (c) => c.notNull())
		.addColumn("list_directly", "integer", (c) => c.notNull())
		.addColumn("trust_annotations", "integer", (c) => c.notNull())
		.addColumn("timeout_ms", "integer", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addUniqueConstraint("mcp_servers_org_name_unique", ["org_id", "name"])
		.execute();

	await db.schema
		.createTable("mcp_server_grants")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("server_id", "text", (c) => c.notNull())
		.addColumn("grantee_type", "text", (c) => c.notNull())
		.addColumn("grantee_id", "text", (c) => c.notNull())
		.addColumn("created_by_user_id", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addUniqueConstraint("mcp_server_grants_unique", ["server_id", "grantee_type", "grantee_id"])
		.execute();
	await db.schema
		.createIndex("mcp_server_grants_grantee_idx")
		.on("mcp_server_grants")
		.columns(["grantee_type", "grantee_id"])
		.execute();

	await db.schema
		.createTable("external_calls")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("actor_type", "text", (c) => c.notNull())
		.addColumn("actor_id", "text", (c) => c.notNull())
		.addColumn("on_behalf_of_user_id", "text", (c) => c.notNull())
		.addColumn("server_name", "text", (c) => c.notNull())
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

	await db.schema.alterTable("sessions").addColumn("disabled_mcp_servers", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("disabled_mcp_servers").execute();
	await db.schema.dropTable("external_calls").execute();
	await db.schema.dropTable("mcp_server_grants").execute();
	await db.schema.dropTable("mcp_servers").execute();
}

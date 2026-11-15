import { type Kysely, sql } from "kysely";
import { newId } from "../../util/id.ts";

/**
 * Extensions, their grants and external calls (doc/design/extensions.md).
 *
 * `extensions` holds both kinds: MCP servers an administrator connected (`kind = 'mcp'`) and crhs's built-in
 * extensions (`kind = 'builtin'`). The two kinds share one name namespace, so `crhs-docs` and `crhs-api` are
 * reserved for the built-ins, which are seeded here and cannot be deleted. An MCP server's request headers are
 * in one `secrets` row referenced by `headers_secret_id`, like a model provider's API key. `availability` says
 * whether every user reaches the extension or only the grants do; built-ins default to everyone, MCP
 * extensions to granted only. A built-in has no URL, headers, identity headers, annotation trust or timeout,
 * so those columns are null for it.
 *
 * `extension_grants` says which users and user groups may use an extension, with the same grantee shape as
 * node access grants.
 *
 * `external_calls` is the small object an external tool approval belongs to: it carries the same rule chain
 * and approval columns as a task, the call's extension, tool, arguments and operation. It keeps only the
 * state that must survive while a call is in progress; a terminal row keeps its state and `finished_at` and
 * clears its arguments, because its id derived from the durable tool call is the "already ran" marker. The
 * result lives in the transcript and the decision in the audit log.
 *
 * `sessions.disabled_extensions` is the JSON list of extension names the owner turned off for that session;
 * a subagent copies its parent's list at creation and can only add to it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
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

	await db.schema.alterTable("sessions").addColumn("disabled_extensions", "text").execute();

	// The built-in extensions exist from the start. v1 has one organization; create it here when the
	// database has none yet (defaultOrgId would otherwise make it on first use, after the seed).
	const now = new Date().toISOString();
	const org = (await sql<{ id: string }>`select id from orgs order by created_at`.execute(db)).rows[0];
	const orgId = org?.id ?? newId();
	if (!org) await sql`insert into orgs (id, name, created_at) values (${orgId}, 'default', ${now})`.execute(db);
	const builtins = [
		{ name: "crhs-docs", description: "The documentation and the API reference of this crhs version" },
		{
			name: "crhs-api",
			description: "The crhs API as the session owner, through the same routes and rules as the WebUI",
		},
	];
	for (const builtin of builtins) {
		await sql`
			insert into extensions (
				id, org_id, name, kind, description, url, headers_secret_id, identity_headers, enabled,
				list_directly, availability, trust_annotations, timeout_ms, created_at, updated_at
			) values (
				${newId()}, ${orgId}, ${builtin.name}, 'builtin', ${builtin.description}, null, null, null, 1,
				1, 'everyone', null, null, ${now}, ${now}
			)`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("disabled_extensions").execute();
	await db.schema.dropTable("external_calls").execute();
	await db.schema.dropTable("extension_grants").execute();
	await db.schema.dropTable("extensions").execute();
}

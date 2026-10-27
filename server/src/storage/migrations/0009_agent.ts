import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	// Agent sessions; each is one durable conversation (doc/agent-runtime.md#会话).
	await db.schema
		.createTable("sessions")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("conversation_id", "text", (c) => c.notNull().unique())
		// Subagents: the session whose tool call created this one; null for a root session.
		.addColumn("parent_session_id", "text")
		.addColumn("title", "text", (c) => c.notNull())
		// JSON { provider, modelId, thinkingLevel? }
		.addColumn("model", "text", (c) => c.notNull())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addColumn("archived_at", "text")
		.execute();
	await db.schema.createIndex("sessions_owner_idx").on("sessions").columns(["owner_user_id", "created_at"]).execute();
	await db.schema.createIndex("sessions_parent_idx").on("sessions").column("parent_session_id").execute();

	// Model providers configured by administrators; API keys live in `secrets`.
	await db.schema
		.createTable("model_providers")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		// The provider id model references use, e.g. "deepseek" or "my-proxy".
		.addColumn("provider_id", "text", (c) => c.notNull().unique())
		// builtin: one of pi-ai's providers (`builtin` names it); openai-compatible: base_url + models.
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("builtin", "text")
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("base_url", "text")
		.addColumn("secret_id", "text")
		// openai-compatible: JSON [{ id, name?, contextWindow, maxTokens, reasoning? }]
		.addColumn("models", "text")
		.addColumn("enabled", "integer", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("model_providers").execute();
	await db.schema.dropTable("sessions").execute();
}

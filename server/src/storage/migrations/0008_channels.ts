import type { Kysely } from "kysely";

/**
 * Chat channels (doc/design/channels.md).
 *
 * `channels` holds one connected chat platform bot: its kind, whether it runs, the encrypted credentials (a
 * `secrets` row, like an extension's headers) and `cursor`, the last platform update handled, so a restart does
 * not handle one twice.
 *
 * `channel_accounts` links one platform account to one CRH user; the pair (channel, platform, platform user id)
 * is unique. `channel_link_codes` holds a one-time code's hash, its expiry and whether it was used.
 *
 * `channel_threads` maps a private chat (and topic, when the platform has them) to one session, or to a draft
 * before the first message starts it (`session_id` null and `draft` set). `current` marks the chat's current
 * session for platforms without topics.
 *
 * `user_settings` is one user's preferences: the UI language, the defaults for new sessions, whether chat
 * progress is shown and the default notification account. A missing row means the defaults.
 *
 * `sessions.last_used_from` says where a session's latest user message came from: `web`, a `channel_threads.id`,
 * or null when a schedule (or another non-WebUI, non-chat submitter) sent it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("channels")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull())
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("enabled", "integer", (c) => c.notNull())
		/** The `secrets` row holding the credentials JSON, encrypted with the master key. */
		.addColumn("credentials_secret_id", "text")
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
		/** A linked chat account notifications go to when the WebUI is not open; null means none. */
		.addColumn("default_channel_account_id", "text")
		.addColumn("updated_at", "text", (c) => c.notNull())
		.execute();

	await db.schema.alterTable("sessions").addColumn("last_used_from", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("sessions").dropColumn("last_used_from").execute();
	await db.schema.dropTable("user_settings").execute();
	await db.schema.dropTable("channel_threads").execute();
	await db.schema.dropTable("channel_link_codes").execute();
	await db.schema.dropTable("channel_accounts").execute();
	await db.schema.dropTable("channels").execute();
}

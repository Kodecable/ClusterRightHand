import { type Kysely, type SqlBool, sql } from "kysely";
import { isPostgres } from "../dialect.ts";

/**
 * Title generation (D116, doc/agent-runtime.md#标题生成): a session's title may be empty, in which case the WebUI
 * shows its localized default name; `title_pending` says a generated title is still wanted. User-created roots
 * start pending and scheduled-run sessions and subagents do not; a manual rename clears it.
 *
 * Existing sessions never get a title made up for them (`title_pending` is false), and the old default title
 * `New session` becomes empty. SQLite cannot drop a column's NOT NULL, so it rebuilds the table; PostgreSQL
 * alters it in place.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (isPostgres(db)) {
		await db.schema
			.alterTable("sessions")
			.alterColumn("title", (column) => column.dropNotNull())
			.execute();
		await db.schema
			.alterTable("sessions")
			.addColumn("title_pending", "integer", (column) => column.notNull().defaultTo(0))
			.execute();
	} else {
		await rebuildSqlite(db, { titleNullable: true, withTitlePending: true });
	}
	await sql`update sessions set title = null where title = 'New session'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`update sessions set title = 'New session' where title is null`.execute(db);
	if (isPostgres(db)) {
		await db.schema
			.alterTable("sessions")
			.alterColumn("title", (column) => column.setNotNull())
			.execute();
		await db.schema.alterTable("sessions").dropColumn("title_pending").execute();
	} else {
		await rebuildSqlite(db, { titleNullable: false, withTitlePending: false });
	}
}

/**
 * Rebuilds `sessions` on SQLite, where nullability cannot be altered in place. The table has no child foreign
 * keys; its own foreign keys and the indexes the runtime relies on are recreated exactly as they were.
 * `title_pending` is only part of the new shape; a copy without it takes the column's default.
 */
async function rebuildSqlite(
	db: Kysely<unknown>,
	target: { titleNullable: boolean; withTitlePending: boolean },
): Promise<void> {
	let table = db.schema
		.createTable("sessions_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("conversation_id", "text", (c) => c.notNull().unique())
		.addColumn("parent_session_id", "text")
		.addColumn("title", "text", (c) => (target.titleNullable ? c : c.notNull()));
	if (target.withTitlePending) table = table.addColumn("title_pending", "integer", (c) => c.notNull().defaultTo(0));
	await table
		.addColumn("model", "text", (c) => c.notNull())
		.addColumn("status", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull())
		.addColumn("updated_at", "text", (c) => c.notNull())
		.addColumn("archived_at", "text")
		.addColumn("budget_used_tokens", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("last_submission_id", "text")
		.addColumn("quota_tokens", "bigint")
		.addColumn("state", "text", (c) => c.notNull().defaultTo("active"))
		.addColumn("waiting_level_id", "text")
		.addColumn("state_changed_at", "text")
		.addColumn("waiting_handler_id", "text")
		.addColumn("schedule_id", "text", (c) => c.references("schedules.id").onDelete("set null"))
		.addColumn("waiting_kind", "text")
		.addColumn("root_session_id", "text")
		.addColumn("usage_tokens", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("context_tokens", "bigint")
		.execute();

	const title = target.titleNullable ? sql`title` : sql`coalesce(title, 'New session')`;
	await sql`
		insert into sessions_new (
			id, org_id, owner_user_id, conversation_id, parent_session_id, title, model, status, created_at,
			updated_at, archived_at, budget_used_tokens, last_submission_id, quota_tokens, state, waiting_level_id,
			state_changed_at, waiting_handler_id, schedule_id, waiting_kind, root_session_id, usage_tokens,
			context_tokens
		)
		select
			id, org_id, owner_user_id, conversation_id, parent_session_id, ${title}, model, status, created_at,
			updated_at, archived_at, budget_used_tokens, last_submission_id, quota_tokens, state, waiting_level_id,
			state_changed_at, waiting_handler_id, schedule_id, waiting_kind, root_session_id, usage_tokens,
			context_tokens
		from sessions
	`.execute(db);

	await db.schema.dropTable("sessions").execute();
	await db.schema.alterTable("sessions_new").renameTo("sessions").execute();

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
}

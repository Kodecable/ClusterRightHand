import { type Kysely, type SqlBool, sql } from "kysely";
import { isPostgres } from "../dialect.ts";

/**
 * A session is `idle` unless a run or a wait is live (doc/design/agent-runtime.md "Session state"). The column's default used
 * to be `active`, which is not a valid `SessionState`; a row inserted without an explicit state therefore looked
 * live to the `state <> 'idle'` partial index. The default becomes `idle` and rows that carry the old default are
 * moved to `idle`. SQLite cannot change a column default in place, so it rebuilds the table; PostgreSQL alters
 * it in place.
 *
 * The table has no child foreign keys. The SQLite rebuild keeps every column, constraint, foreign key and index,
 * with the default as the only change.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`update sessions set state = 'idle' where state = 'active'`.execute(db);
	if (isPostgres(db)) {
		await db.schema
			.alterTable("sessions")
			.alterColumn("state", (column) => column.setDefault("idle"))
			.execute();
	} else {
		await rebuildSqlite(db, "idle");
	}
}

/**
 * Restores the old default. The state rewrite is not reversible: an `idle` row may have been idle before this
 * migration, so it is left alone.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
	if (isPostgres(db)) {
		await db.schema
			.alterTable("sessions")
			.alterColumn("state", (column) => column.setDefault("active"))
			.execute();
	} else {
		await rebuildSqlite(db, "active");
	}
}

/** Rebuilds `sessions` on SQLite, where a column default cannot be altered in place. */
async function rebuildSqlite(db: Kysely<unknown>, stateDefault: string): Promise<void> {
	await db.schema
		.createTable("sessions_new")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("org_id", "text", (c) => c.notNull().references("orgs.id"))
		.addColumn("owner_user_id", "text", (c) => c.notNull().references("users.id"))
		.addColumn("conversation_id", "text", (c) => c.notNull().unique())
		.addColumn("parent_session_id", "text")
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
		.addColumn("state", "text", (c) => c.notNull().defaultTo(stateDefault))
		.addColumn("waiting_level_id", "text")
		.addColumn("state_changed_at", "text")
		.addColumn("waiting_handler_id", "text")
		.addColumn("schedule_id", "text", (c) => c.references("schedules.id").onDelete("set null"))
		.addColumn("waiting_kind", "text")
		.addColumn("root_session_id", "text")
		.addColumn("usage_tokens", "bigint", (c) => c.notNull().defaultTo(0))
		.addColumn("context_tokens", "bigint")
		.addColumn("create_request_id", "text")
		.execute();

	await sql`
		insert into sessions_new (
			id, org_id, owner_user_id, conversation_id, parent_session_id, title, title_pending, model, status,
			created_at, updated_at, archived_at, budget_used_tokens, last_submission_id, quota_tokens, state,
			waiting_level_id, state_changed_at, waiting_handler_id, schedule_id, waiting_kind, root_session_id,
			usage_tokens, context_tokens, create_request_id
		)
		select
			id, org_id, owner_user_id, conversation_id, parent_session_id, title, title_pending, model, status,
			created_at, updated_at, archived_at, budget_used_tokens, last_submission_id, quota_tokens, state,
			waiting_level_id, state_changed_at, waiting_handler_id, schedule_id, waiting_kind, root_session_id,
			usage_tokens, context_tokens, create_request_id
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
	await db.schema
		.createIndex("sessions_owner_create_request_unique")
		.on("sessions")
		.columns(["owner_user_id", "create_request_id"])
		.unique()
		.execute();
}

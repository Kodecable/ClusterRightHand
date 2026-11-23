import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/storage/db.ts";
import { migrateToLatest, runMigrations } from "../src/storage/migrate.ts";
import { type Backend, describeBackends, openTestDb, withDdlLockOn } from "./helpers/db.ts";

// Opening a schema runs the migrator or creates tables under the shared DDL lock; in the full parallel
// PostgreSQL suite the wait for it can pass Vitest's 5s test and 10s hook defaults. These cases open one or
// more schemas themselves, so they get a longer limit rather than a flaky timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Columns of the named table in this connection's own schema, or undefined when it does not exist.
 *
 * On PostgreSQL every test file gets its own schema in a shared database, and Kysely's introspector
 * enumerates all of them, so it fails when a parallel file drops its schema mid-introspection. Querying
 * information_schema.columns for current_schema() reads this connection's own schema only. SQLite has a
 * single, unnamed schema and its in-memory introspection is per-file, so that path stays introspective.
 */
async function tableColumns(backend: Backend, db: Db, name: string): Promise<string[] | undefined> {
	if (backend === "postgres") {
		const result = await sql<{ column_name: string }>`
			select column_name from information_schema.columns
			where table_schema = current_schema() and table_name = ${name}
			order by ordinal_position
		`.execute(db);
		return result.rows.length === 0 ? undefined : result.rows.map((row) => row.column_name);
	}
	const table = (await db.introspection.getTables()).find((candidate) => candidate.name === name);
	return table?.columns.map((column) => column.name);
}

/** Whether the named column is NOT NULL. */
async function isNotNull(backend: Backend, db: Db, table: string, column: string): Promise<boolean> {
	if (backend === "postgres") {
		const result = await sql<{ is_nullable: string }>`
			select is_nullable from information_schema.columns
			where table_schema = current_schema() and table_name = ${table} and column_name = ${column}
		`.execute(db);
		return result.rows[0]?.is_nullable === "NO";
	}
	const result = await sql<{ name: string; notnull: number }>`
		select name, "notnull" from pragma_table_info(${table})
	`.execute(db);
	return result.rows.find((row) => row.name === column)?.notnull === 1;
}

/** The application tables, without the migrator's own bookkeeping. */
async function tableNames(backend: Backend, db: Db): Promise<string[]> {
	const result =
		backend === "postgres"
			? await sql<{ name: string }>`
					select table_name as name from information_schema.tables
					where table_schema = current_schema() and table_name not like 'kysely_%'
					order by table_name
				`.execute(db)
			: await sql<{ name: string }>`
					select name from sqlite_master
					where type = 'table' and name not like 'sqlite_%' and name not like 'kysely_%'
					order by name
				`.execute(db);
	return result.rows.map((row) => row.name);
}

/** The explicitly named indexes; primary-key and unique-constraint indexes are dialect-named. */
async function hasIndex(backend: Backend, db: Db, name: string): Promise<boolean> {
	const result =
		backend === "postgres"
			? await sql<{ name: string }>`
					select indexname as name from pg_indexes
					where schemaname = current_schema() and indexname = ${name}
				`.execute(db)
			: await sql<{ name: string }>`select name from sqlite_master where type = 'index' and name = ${name}`.execute(db);
	return result.rows.length > 0;
}

const TABLES = [
	"api_tokens",
	"audit_events",
	"authorizations",
	"channel_accounts",
	"channel_link_codes",
	"channel_threads",
	"channels",
	"enrollment_tokens",
	"extension_grants",
	"extensions",
	"external_calls",
	"image_cache",
	"jobs",
	"libraries",
	"library_files",
	"library_skills",
	"model_presets",
	"model_providers",
	"node_access_grants",
	"node_group_members",
	"node_groups",
	"nodes",
	"orgs",
	"rule_sets",
	"schedule_runs",
	"schedules",
	"secrets",
	"server_meta",
	"sessions",
	"settings",
	"shares",
	"signing_credentials",
	"ssh_credentials",
	"task_groups",
	"tasks",
	"user_group_members",
	"user_groups",
	"user_settings",
	"users",
	"web_sessions",
];

const INDEXES = [
	"audit_events_ts_idx",
	"authorizations_deadline_idx",
	"channel_accounts_user_idx",
	"channel_link_codes_user_idx",
	"channel_threads_chat_idx",
	"channel_threads_session_idx",
	"node_access_grants_grantee_idx",
	"nodes_org_name_key_unique",
	"schedules_due_idx",
	"sessions_owner_create_request_unique",
	"sessions_state_live_idx",
	"image_cache_last_used_idx",
	"library_files_object_key_idx",
	"extension_grants_grantee_idx",
	"external_calls_actor_idx",
	"external_calls_state_idx",
	"tasks_handler_agent_idx",
	"jobs_session_state_idx",
	"jobs_resource_idx",
	"user_group_members_user_id_idx",
	"web_sessions_expires_at_idx",
];

describeBackends("initial migration", (backend) => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb(backend);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("creates the schema", async () => {
		expect(await tableNames(backend, db)).toEqual(TABLES);
		for (const index of INDEXES) expect(await hasIndex(backend, db, index), index).toBe(true);

		// The columns the squash had to get right: final nullability, defaults and renames.
		expect(await tableColumns(backend, db, "authorizations")).toEqual([
			"id",
			"org_id",
			"payload",
			"signatures",
			"issuer_user_id",
			"task_ids",
			"deadline",
			"created_at",
		]);
		expect(await isNotNull(backend, db, "authorizations", "deadline")).toBe(true);
		expect(await isNotNull(backend, db, "sessions", "title")).toBe(false);
		expect(await tableColumns(backend, db, "external_calls")).toEqual([
			"id",
			"org_id",
			"actor_type",
			"actor_id",
			"on_behalf_of_user_id",
			"extension_name",
			"tool_name",
			"arguments",
			"operation",
			"annotations",
			"rule_chain",
			"approval",
			"pending_input",
			"root_session_id",
			"handler_type",
			"handler_session_id",
			"state",
			"created_at",
			"finished_at",
			"source_tool_task",
			"tool_rev",
		]);
		// A terminal row clears its arguments, so the column is nullable.
		expect(await isNotNull(backend, db, "external_calls", "arguments")).toBe(false);
		expect(await tableColumns(backend, db, "image_cache")).toEqual([
			"sha256",
			"bytes",
			"mime",
			"last_used_at",
			"stored_at",
		]);
		expect(await tableColumns(backend, db, "jobs")).toEqual([
			"id",
			"org_id",
			"actor_type",
			"actor_id",
			"on_behalf_of_user_id",
			"session_id",
			"call_key",
			"kind",
			"resource_type",
			"resource_id",
			"action",
			"state",
			"outcome",
			"wait",
			"result",
			"notice",
			"created_at",
			"settled_at",
		]);
		// An MCP client has no session; every other job has one, and the row goes with it.
		expect(await isNotNull(backend, db, "jobs", "session_id")).toBe(false);
		expect(await isNotNull(backend, db, "jobs", "call_key")).toBe(true);
		expect(await isNotNull(backend, db, "jobs", "notice")).toBe(true);

		const sessions = await tableColumns(backend, db, "sessions");
		expect(sessions).toContain("title_pending");
		expect(sessions).toContain("create_request_id");
		expect(sessions).toContain("counted_submission_id");
		expect(sessions).toContain("forked_from_session_id");
		expect(sessions).toContain("forked_from_entry_id");
		expect(sessions).toEqual(expect.arrayContaining(["todos", "todos_at_compaction"]));
		// A cleared list and a session that never had one are both null.
		expect(await isNotNull(backend, db, "sessions", "todos")).toBe(false);
		expect(await isNotNull(backend, db, "sessions", "todos_at_compaction")).toBe(false);
		expect(await tableColumns(backend, db, "nodes")).toContain("ssh_host_fingerprint");
		expect(await tableColumns(backend, db, "tasks")).toEqual(
			expect.arrayContaining([
				"rev",
				"output_head",
				"result",
				"transfer",
				"purpose",
				"source_tool_task",
				"output_lost",
			]),
		);
		// Output loss is a stored fact; existing rows default to "not lost".
		expect(await isNotNull(backend, db, "tasks", "output_lost")).toBe(true);
		// A late result is recorded in the normal result columns, not in a separate JSON column.
		expect(await tableColumns(backend, db, "tasks")).not.toContain("late_result");
		// The state carries a cancellation; there is no separate flag column.
		expect(await tableColumns(backend, db, "tasks")).not.toContain("cancelled");
		expect(await tableColumns(backend, db, "task_groups")).toEqual(
			expect.arrayContaining(["transfer", "source_tool_task"]),
		);
		expect(await tableColumns(backend, db, "tasks")).not.toContain("source_call_id");
		expect(await tableColumns(backend, db, "task_groups")).not.toContain("source_call_id");
		expect(await tableColumns(backend, db, "external_calls")).not.toContain("source_call_id");
		expect(await tableColumns(backend, db, "sessions")).toContain("last_used_from");
		expect(await tableColumns(backend, db, "channels")).toEqual(
			expect.arrayContaining([
				"name",
				"kind",
				"enabled",
				"credentials_secret_id",
				"config",
				"link_instructions",
				"cursor",
			]),
		);
		expect(await tableColumns(backend, db, "channels")).not.toContain("default_model");
		expect(await tableColumns(backend, db, "channels")).not.toContain("default_rule_preset");
		expect(await tableColumns(backend, db, "channel_threads")).toEqual(
			expect.arrayContaining(["chat_id", "topic_id", "session_id", "draft", "current"]),
		);
		// A thread without a session holds a draft until its first message starts the session.
		expect(await isNotNull(backend, db, "channel_threads", "session_id")).toBe(false);
		expect(await tableColumns(backend, db, "user_settings")).toEqual([
			"user_id",
			"locale",
			"default_model",
			"default_rule_preset",
			"show_progress",
			"default_channel_account_id",
			"updated_at",
		]);
		expect(await isNotNull(backend, db, "user_settings", "show_progress")).toBe(true);
	});

	it("defaults a user settings row to showing chat progress", async () => {
		await sql`
			insert into user_settings (user_id, updated_at) values ('user-1', '2026-01-01T00:00:00.000Z')`.execute(db);
		const row = await db
			.selectFrom("user_settings")
			.selectAll()
			.where("user_id", "=", "user-1")
			.executeTakeFirstOrThrow();
		expect(row).toEqual({
			user_id: "user-1",
			locale: null,
			default_model: null,
			default_rule_preset: null,
			show_progress: 1,
			default_channel_account_id: null,
			updated_at: "2026-01-01T00:00:00.000Z",
		});
	});

	it("nulls a default notification account when the account is deleted", async () => {
		await sql`
			insert into channel_accounts (id, channel_id, platform, platform_user_id, user_id, linked_at)
			values ('account-1', 'channel-1', 'telegram', 'tg-1', 'user-1', '2026-01-01T00:00:00.000Z')`.execute(db);
		await sql`
			insert into user_settings (user_id, default_channel_account_id, updated_at)
			values ('user-1', 'account-1', '2026-01-01T00:00:00.000Z')`.execute(db);
		await sql`delete from channel_accounts where id = 'account-1'`.execute(db);
		const row = await db
			.selectFrom("user_settings")
			.select("default_channel_account_id")
			.where("user_id", "=", "user-1")
			.executeTakeFirstOrThrow();
		expect(row.default_channel_account_id).toBeNull();
	});

	it("seeds the built-in extensions", async () => {
		const rows = await db
			.selectFrom("extensions")
			.select(["name", "kind", "enabled", "list_directly", "availability"])
			.orderBy("name")
			.execute();
		expect(rows).toEqual([
			{ name: "crhs-api", kind: "builtin", enabled: 1, list_directly: 1, availability: "everyone" },
			{ name: "crhs-docs", kind: "builtin", enabled: 1, list_directly: 1, availability: "everyone" },
			// Billed per call and needs an API key first: shipped disabled.
			{ name: "crhs-ds-search", kind: "builtin", enabled: 0, list_directly: 1, availability: "everyone" },
		]);
	});

	it("is idempotent on a second run", async () => {
		const schema =
			backend === "postgres"
				? (await sql<{ name: string }>`select current_schema() as name`.execute(db)).rows[0]?.name
				: undefined;
		// The migrator introspects every schema, so a parallel test dropping its schema must not run now.
		await withDdlLockOn(backend, () => migrateToLatest(db, schema ? { schema } : {}));
		const rows = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db);
		expect(rows.rows).toEqual([{ name: "0001_initial" }]);
		expect(await tableNames(backend, db)).toEqual(TABLES);
	});
});

/**
 * SQLite's DDL is transactional, so a failed migration batch must leave neither half a table rebuild nor a
 * migration record behind. PostgreSQL's migrator already wraps the batch (and is covered by the backend suites).
 */
describe("SQLite migration transactions", () => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb("sqlite", { migrate: false });
	});

	afterEach(async () => {
		await db.destroy();
	});

	const first: Migration = {
		up: async (migrationDb) => {
			await migrationDb.schema
				.createTable("b5_items")
				.addColumn("id", "text", (c) => c.primaryKey())
				.addColumn("label", "text", (c) => c.notNull())
				.execute();
			await sql`insert into b5_items (id, label) values ('item', 'kept')`.execute(migrationDb);
		},
	};

	/** Rebuilds a table the way a migration must on SQLite: copy into a new table, drop the old one, rename. */
	async function rebuildItems(migrationDb: Kysely<unknown>): Promise<void> {
		await migrationDb.schema
			.createTable("b5_items_new")
			.addColumn("id", "text", (c) => c.primaryKey())
			.addColumn("label", "text", (c) => c.notNull())
			.execute();
		await sql`insert into b5_items_new (id, label) select id, label from b5_items`.execute(migrationDb);
		await migrationDb.schema.dropTable("b5_items").execute();
		await migrationDb.schema.alterTable("b5_items_new").renameTo("b5_items").execute();
	}

	const failing: Migration = {
		up: async (migrationDb) => {
			await rebuildItems(migrationDb);
			throw new Error("migration failed after the table rebuild");
		},
	};

	const fixed: Migration = {
		up: async (migrationDb) => {
			await rebuildItems(migrationDb);
			await migrationDb.schema.alterTable("b5_items").addColumn("extra", "text").execute();
		},
	};

	const list = (last: Migration) => ({ "0001_first": first, "0002_second": last });

	const migrationNames = async (): Promise<string[]> =>
		(await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db)).rows.map(
			(row) => row.name,
		);

	const itemRows = async (): Promise<{ id: string; label: string }[]> =>
		(await sql<{ id: string; label: string }>`select id, label from b5_items order by id`.execute(db)).rows;

	it("rolls back a failed table rebuild and lets the fixed migrations run", async () => {
		await expect(runMigrations(db, list(failing))).rejects.toThrow("migration 0002_second failed");

		// The second migration rebuilt and renamed the table before throwing; the whole batch is one
		// transaction, so the first migration's table and row and the migrator's insert are rolled back too.
		const tables = await sql<{ name: string }>`
			select name from sqlite_master where type = 'table' and name like 'b5_%' order by name
		`.execute(db);
		expect(tables.rows).toEqual([]);
		expect(await migrationNames()).toEqual([]);

		await runMigrations(db, list(fixed));
		expect(await migrationNames()).toEqual(["0001_first", "0002_second"]);
		expect(await itemRows()).toEqual([{ id: "item", label: "kept" }]);
		expect(await tableColumns("sqlite", db, "b5_items")).toEqual(["id", "label", "extra"]);
	});
});

import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/storage/db.ts";
import { migrateToLatest, runMigrations } from "../src/storage/migrate.ts";
import * as m0001 from "../src/storage/migrations/0001_initial.ts";
import * as m0002 from "../src/storage/migrations/0002_task_transfer.ts";
import * as m0003 from "../src/storage/migrations/0003_libraries.ts";
import * as m0004 from "../src/storage/migrations/0004_purpose_and_image_cache.ts";
import * as m0005 from "../src/storage/migrations/0005_task_group_transfer.ts";
import * as m0006 from "../src/storage/migrations/0006_image_state.ts";
import * as m0007 from "../src/storage/migrations/0007_extensions.ts";
import * as m0008 from "../src/storage/migrations/0008_channels.ts";
import * as m0009 from "../src/storage/migrations/0009_authorization_lookup.ts";
import * as m0010 from "../src/storage/migrations/0010_review_tool_task.ts";
import * as m0011 from "../src/storage/migrations/0011_delete_ssh_signing_credentials.ts";
import * as m0012 from "../src/storage/migrations/0012_task_output_lost.ts";
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
	"libraries",
	"library_files",
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

		const sessions = await tableColumns(backend, db, "sessions");
		expect(sessions).toContain("title_pending");
		expect(sessions).toContain("create_request_id");
		expect(sessions).toContain("counted_submission_id");
		expect(sessions).toContain("forked_from_session_id");
		expect(sessions).toContain("forked_from_entry_id");
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
		expect(rows.rows).toEqual([
			{ name: "0001_initial" },
			{ name: "0002_task_transfer" },
			{ name: "0003_libraries" },
			{ name: "0004_purpose_and_image_cache" },
			{ name: "0005_task_group_transfer" },
			{ name: "0006_image_state" },
			{ name: "0007_extensions" },
			{ name: "0008_channels" },
			{ name: "0009_authorization_lookup" },
			{ name: "0010_review_tool_task" },
			{ name: "0011_delete_ssh_signing_credentials" },
			{ name: "0012_task_output_lost" },
		]);
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

describe("image state migration", () => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb("sqlite", { migrate: false });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("gives an existing image cache row its last use as stored_at", async () => {
		const before = {
			"0001_initial": m0001,
			"0002_task_transfer": m0002,
			"0003_libraries": m0003,
			"0004_purpose_and_image_cache": m0004,
			"0005_task_group_transfer": m0005,
		};
		await runMigrations(db, before);
		await sql`
			insert into image_cache (sha256, bytes, mime, last_used_at)
			values ('abc', 3, 'image/png', '2026-01-02T00:00:00.000Z')`.execute(db);
		await runMigrations(db, { ...before, "0006_image_state": m0006 });
		const row = await db
			.selectFrom("image_cache")
			.select("stored_at")
			.where("sha256", "=", "abc")
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ stored_at: "2026-01-02T00:00:00.000Z" });
	});
});

describe("review tool task migration", () => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb("sqlite", { migrate: false });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("replaces the model call id with the durable tool task and drops its values", async () => {
		const before = {
			"0001_initial": m0001,
			"0002_task_transfer": m0002,
			"0003_libraries": m0003,
			"0004_purpose_and_image_cache": m0004,
			"0005_task_group_transfer": m0005,
			"0006_image_state": m0006,
			"0007_extensions": m0007,
			"0008_channels": m0008,
			"0009_authorization_lookup": m0009,
		};
		await runMigrations(db, before);
		const now = "2026-01-01T00:00:00.000Z";
		await sql`insert into orgs (id, name, created_at) values ('org-1', 'Org', ${now})`.execute(db);
		await sql`
			insert into tasks (
				id, org_id, node_id, kind, spec, privileged, state, timed_out, actor_type, actor_id,
				on_behalf_of_user_id, created_at, source_call_id
			) values ('task-1', 'org-1', 'node-1', 'exec', '{}', 0, 'awaiting_approval', 0, 'session', 'session-1',
				'user-1', ${now}, 'call_0')`.execute(db);
		await sql`
			insert into task_groups (
				id, org_id, targets, node_ids, kind, parallel, fail_fast, skipped, state, actor_type, actor_id,
				on_behalf_of_user_id, created_at, source_call_id
			) values ('group-1', 'org-1', '[]', '[]', 'exec', 1, 0, '[]', 'awaiting_approval', 'session', 'session-1',
				'user-1', ${now}, 'call_0')`.execute(db);
		await sql`
			insert into external_calls (
				id, org_id, actor_type, actor_id, on_behalf_of_user_id, extension_name, tool_name, operation,
				source_call_id, state, created_at
			) values ('call-1', 'org-1', 'session', 'session-1', 'user-1', 'test', 'echo', '{}', 'call_0',
				'awaiting_approval', ${now})`.execute(db);

		await runMigrations(db, { ...before, "0010_review_tool_task": m0010 });

		for (const table of ["tasks", "task_groups", "external_calls"]) {
			expect(await tableColumns("sqlite", db, table), table).toContain("source_tool_task");
			expect(await tableColumns("sqlite", db, table), table).not.toContain("source_call_id");
		}
		const tasks = await sql<{ source_tool_task: string | null }>`
			select source_tool_task from tasks where id = 'task-1'`.execute(db);
		const groups = await sql<{ source_tool_task: string | null }>`
			select source_tool_task from task_groups where id = 'group-1'`.execute(db);
		const calls = await sql<{ source_tool_task: string | null }>`
			select source_tool_task from external_calls where id = 'call-1'`.execute(db);
		// The old values were model call ids; they are dropped, not carried over.
		expect(tasks.rows[0]?.source_tool_task).toBeNull();
		expect(groups.rows[0]?.source_tool_task).toBeNull();
		expect(calls.rows[0]?.source_tool_task).toBeNull();
	});
});

describe("SSH signing credential cleanup migration", () => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb("sqlite", { migrate: false });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("deletes SSH credentials but keeps Passkeys", async () => {
		const before = {
			"0001_initial": m0001,
			"0002_task_transfer": m0002,
			"0003_libraries": m0003,
			"0004_purpose_and_image_cache": m0004,
			"0005_task_group_transfer": m0005,
			"0006_image_state": m0006,
			"0007_extensions": m0007,
			"0008_channels": m0008,
			"0009_authorization_lookup": m0009,
			"0010_review_tool_task": m0010,
		};
		await runMigrations(db, before);
		const now = "2026-01-01T00:00:00.000Z";
		await sql`insert into orgs (id, name, created_at) values ('org-1', 'Org', ${now})`.execute(db);
		await sql`
			insert into users (id, org_id, username, display_name, kind, status, created_at)
			values ('user-1', 'org-1', 'alice', 'Alice', 'member', 'active', ${now})`.execute(db);
		const insert = (id: string, kind: string, fingerprint: string | null, credentialId: string | null) =>
			sql`
			insert into signing_credentials (id, user_id, kind, name, public_key, fingerprint, credential_id, rp_id, created_at)
			values (${id}, 'user-1', ${kind}, ${id}, 'key', ${fingerprint}, ${credentialId}, null, ${now})`.execute(db);
		await insert("ssh-1", "ssh", "SHA256:one", null);
		await insert("ssh-2", "ssh", "SHA256:two", null);
		await insert("passkey-1", "webauthn", null, "credential-1");

		await runMigrations(db, { ...before, "0011_delete_ssh_signing_credentials": m0011 });

		const rows = await db.selectFrom("signing_credentials").select(["id", "kind"]).orderBy("id").execute();
		expect(rows).toEqual([{ id: "passkey-1", kind: "webauthn" }]);
	});
});

describe("library backfill migration", () => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb("sqlite", { migrate: false });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("creates a library for every existing user and user group", async () => {
		await runMigrations(db, { "0001_initial": m0001, "0002_task_transfer": m0002 });
		await sql`insert into orgs (id, name, created_at) values ('org-1', 'Org', '2026-01-01T00:00:00.000Z')`.execute(db);
		await sql`
			insert into users (id, org_id, username, display_name, email, kind, password_hash, status, created_at)
			values ('user-1', 'org-1', 'alice', 'Alice', null, 'member', null, 'active', '2026-01-01T00:00:00.000Z')`.execute(
			db,
		);
		await sql`
			insert into user_groups (id, org_id, name, source, created_at)
			values ('group-1', 'org-1', 'team', 'local', '2026-01-02T00:00:00.000Z')`.execute(db);

		await runMigrations(db, {
			"0001_initial": m0001,
			"0002_task_transfer": m0002,
			"0003_libraries": m0003,
		});
		const rows = await sql<{
			owner_kind: string;
			owner_id: string;
			max_files: number;
			max_file_bytes: number;
			max_total_bytes: number;
			created_at: string;
		}>`select owner_kind, owner_id, max_files, max_file_bytes, max_total_bytes, created_at from libraries order by owner_kind`.execute(
			db,
		);
		expect(rows.rows).toEqual([
			{
				owner_kind: "user",
				owner_id: "user-1",
				max_files: 256,
				max_file_bytes: 32 * 1024 * 1024,
				max_total_bytes: 256 * 1024 * 1024,
				created_at: "2026-01-01T00:00:00.000Z",
			},
			{
				owner_kind: "user_group",
				owner_id: "group-1",
				max_files: 0,
				max_file_bytes: 0,
				max_total_bytes: 0,
				created_at: "2026-01-02T00:00:00.000Z",
			},
		]);
	});
});

describe("task output lost migration", () => {
	let db: Db;

	beforeEach(async () => {
		db = await openTestDb("sqlite", { migrate: false });
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("adds output_lost non-null with a false default for existing rows", async () => {
		const before = {
			"0001_initial": m0001,
			"0002_task_transfer": m0002,
			"0003_libraries": m0003,
			"0004_purpose_and_image_cache": m0004,
			"0005_task_group_transfer": m0005,
			"0006_image_state": m0006,
			"0007_extensions": m0007,
			"0008_channels": m0008,
			"0009_authorization_lookup": m0009,
			"0010_review_tool_task": m0010,
			"0011_delete_ssh_signing_credentials": m0011,
		};
		await runMigrations(db, before);
		const now = "2026-01-01T00:00:00.000Z";
		await sql`insert into orgs (id, name, created_at) values ('org-1', 'Org', ${now})`.execute(db);
		await sql`
			insert into tasks (
				id, org_id, node_id, kind, spec, privileged, state, timed_out, actor_type, actor_id,
				on_behalf_of_user_id, created_at
			) values ('task-1', 'org-1', 'node-1', 'exec', '{}', 0, 'running', 0, 'user', 'user-1',
				'user-1', ${now})`.execute(db);

		await runMigrations(db, { ...before, "0012_task_output_lost": m0012 });

		expect(await tableColumns("sqlite", db, "tasks")).toContain("output_lost");
		expect(await isNotNull("sqlite", db, "tasks", "output_lost")).toBe(true);
		const rows = await sql<{ output_lost: number }>`
			select output_lost from tasks where id = 'task-1'`.execute(db);
		expect(rows.rows[0]?.output_lost).toBe(0);
	});
});

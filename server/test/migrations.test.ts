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
	"enrollment_tokens",
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
	"users",
	"web_sessions",
];

const INDEXES = [
	"audit_events_ts_idx",
	"authorizations_deadline_idx",
	"node_access_grants_grantee_idx",
	"nodes_org_name_key_unique",
	"schedules_due_idx",
	"sessions_owner_create_request_unique",
	"sessions_state_live_idx",
	"image_cache_last_used_idx",
	"library_files_object_key_idx",
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
		expect(await tableColumns(backend, db, "nodes")).toContain("ssh_host_fingerprint");
		expect(await tableColumns(backend, db, "tasks")).toEqual(
			expect.arrayContaining(["rev", "output_head", "result", "transfer", "purpose"]),
		);
		expect(await tableColumns(backend, db, "task_groups")).toContain("transfer");
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
				owner_kind: "group",
				owner_id: "group-1",
				max_files: 0,
				max_file_bytes: 0,
				max_total_bytes: 0,
				created_at: "2026-01-02T00:00:00.000Z",
			},
			{
				owner_kind: "user",
				owner_id: "user-1",
				max_files: 256,
				max_file_bytes: 32 * 1024 * 1024,
				max_total_bytes: 256 * 1024 * 1024,
				created_at: "2026-01-01T00:00:00.000Z",
			},
		]);
	});
});

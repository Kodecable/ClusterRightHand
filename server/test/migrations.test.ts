import { type Kysely, sql } from "kysely";
import type { Migration } from "kysely/migration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/storage/db.ts";
import { migrateToLatest, runMigrations } from "../src/storage/migrate.ts";
import { type Backend, describeBackends, openTestDb } from "./helpers/db.ts";

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

		const sessions = await tableColumns(backend, db, "sessions");
		expect(sessions).toContain("title_pending");
		expect(sessions).toContain("create_request_id");
		expect(sessions).toContain("counted_submission_id");
		expect(await tableColumns(backend, db, "nodes")).toContain("ssh_host_fingerprint");
		expect(await tableColumns(backend, db, "tasks")).toEqual(
			expect.arrayContaining(["rev", "output_head", "result", "transfer"]),
		);
	});

	it("is idempotent on a second run", async () => {
		const schema =
			backend === "postgres"
				? (await sql<{ name: string }>`select current_schema() as name`.execute(db)).rows[0]?.name
				: undefined;
		await migrateToLatest(db, schema ? { schema } : {});
		const rows = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db);
		expect(rows.rows).toEqual([{ name: "0001_initial" }, { name: "0002_task_transfer" }]);
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

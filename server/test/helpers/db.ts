import { randomBytes } from "node:crypto";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import pg from "pg";
import { describe } from "vitest";
import type { Db } from "../../src/storage/db.ts";
import { migrateToLatest } from "../../src/storage/migrate.ts";
import { openNodeSqlite } from "../../src/storage/node-sqlite.ts";
import type { Database } from "../../src/storage/schema.ts";

const pgUrl = process.env.CRH_TEST_PG_URL;

export type Backend = "sqlite" | "postgres";

/** Runs the suite once per backend; PostgreSQL runs only when CRH_TEST_PG_URL is set. */
export function describeBackends(name: string, fn: (backend: Backend) => void): void {
	describe.each(["sqlite", "postgres"] as const)(`${name} (%s)`, (backend) => {
		if (backend === "postgres" && !pgUrl) {
			describe.skip("CRH_TEST_PG_URL not set", () => fn(backend));
			return;
		}
		fn(backend);
	});
}

/** Opens an empty, migrated database. On PostgreSQL every call gets its own schema, dropped on destroy. */
export async function openTestDb(backend: Backend, { migrate = true } = {}): Promise<Db> {
	let db: Db;
	let schema: string | undefined;
	if (backend === "sqlite") {
		db = new Kysely<Database>({ dialect: new SqliteDialect({ database: openNodeSqlite(":memory:") }) });
	} else {
		const name = `t_${randomBytes(6).toString("hex")}`;
		schema = name;
		const pool = new pg.Pool({ connectionString: pgUrl, options: `-c search_path=${name}` });
		const pgDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
		await withDdlLock(async () => {
			await sql`create schema ${sql.id(name)}`.execute(pgDb);
			if (migrate) await migrateToLatest(pgDb, { schema: name });
		});
		const destroy = pgDb.destroy.bind(pgDb);
		pgDb.destroy = async () => {
			await withDdlLock(() => sql`drop schema ${sql.id(name)} cascade`.execute(pgDb));
			await destroy();
		};
		return pgDb;
	}
	if (migrate) await migrateToLatest(db, { schema });
	return db;
}

/**
 * Kysely's migrator introspects every schema in the database, which fails if a parallel test file drops its
 * schema at the same moment. Test files therefore take turns for DDL.
 */
async function withDdlLock<T>(fn: () => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: pgUrl });
	await client.connect();
	try {
		await client.query("select pg_advisory_lock(7042001)");
		return await fn();
	} finally {
		await client.end(); // releases the session-level lock
	}
}

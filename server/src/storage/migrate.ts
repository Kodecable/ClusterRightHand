import type { DialectAdapter, Kysely } from "kysely";
import { type Migration, type MigrationProvider, type MigrationResult, Migrator } from "kysely/migration";
import * as m0001 from "./migrations/0001_initial.ts";

/** Migrations are listed explicitly so they work the same from source and from a bundle. */
const migrations: Record<string, Migration> = {
	"0001_initial": m0001,
};

/** Options shared by the migration entry points. */
export interface MigrateOptions {
	/** Schema the migrator's bookkeeping tables live in; PostgreSQL only (see `migrateToLatest`). */
	schema?: string;
}

/**
 * Runs every pending migration.
 *
 * With a schema, the migrator only looks for its bookkeeping tables there (PostgreSQL); otherwise its table
 * introspection can see the same-named tables of another schema in the database.
 */
// biome-ignore lint/suspicious/noExplicitAny: the migrator works on any schema
export async function migrateToLatest(db: Kysely<any>, options: MigrateOptions = {}): Promise<MigrationResult[]> {
	return runMigrations(db, migrations, options);
}

/**
 * Runs the given migration list on `db`; tests use it to exercise their own migrations. The whole batch of
 * pending migrations runs in one transaction, including the migrator's bookkeeping inserts, so a failure
 * halfway through a table rebuild leaves the schema and the migration table exactly as they were.
 *
 * SQLite's DDL is transactional, but Kysely's `SqliteAdapter` reports `supportsTransactionalDdl` as false, so the
 * migrator would otherwise run SQLite migrations without a transaction. That flag is overridden on the adapter
 * of the given instance; the migrator then uses this database's own driver, connection and transaction
 * machinery. PostgreSQL already reports true and is unaffected.
 */
export async function runMigrations(
	// biome-ignore lint/suspicious/noExplicitAny: the migrator works on any schema
	db: Kysely<any>,
	migrationSet: Record<string, Migration>,
	options: MigrateOptions = {},
): Promise<MigrationResult[]> {
	const migrator = new Migrator({
		db: withTransactionalDdl(db),
		provider: providerFor(migrationSet),
		migrationTableSchema: options.schema,
	});
	const { error, results } = await migrator.migrateToLatest();
	const failed = results?.find((r) => r.status === "Error");
	if (error || failed) {
		throw new Error(`migration ${failed?.migrationName ?? "?"} failed`, { cause: error });
	}
	return results ?? [];
}

function providerFor(migrationSet: Record<string, Migration>): MigrationProvider {
	return { getMigrations: async () => migrationSet };
}

/** Marks the adapter as supporting transactional DDL; only SQLite's adapter reports false. */
function withTransactionalDdl<DB>(db: Kysely<DB>): Kysely<DB> {
	const adapter: DialectAdapter = db.getExecutor().adapter;
	if (!adapter.supportsTransactionalDdl) {
		Object.defineProperty(adapter, "supportsTransactionalDdl", { value: true, configurable: true });
	}
	return db;
}

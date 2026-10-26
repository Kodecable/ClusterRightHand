import type { Kysely } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import * as m0001 from "./migrations/0001_init.ts";
import * as m0002 from "./migrations/0002_users_and_sharing.ts";
import * as m0003 from "./migrations/0003_keys.ts";
import * as m0004 from "./migrations/0004_nodes.ts";
import * as m0005 from "./migrations/0005_tasks.ts";

/** Migrations are listed explicitly so they work the same from source and from a bundle. */
const migrations: Record<string, Migration> = {
	"0001_init": m0001,
	"0002_users_and_sharing": m0002,
	"0003_keys": m0003,
	"0004_nodes": m0004,
	"0005_tasks": m0005,
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

// biome-ignore lint/suspicious/noExplicitAny: the migrator works on any schema
export async function migrateToLatest(db: Kysely<any>, options: { schema?: string } = {}): Promise<void> {
	// With a schema, the migrator only looks for its bookkeeping tables there (PostgreSQL); otherwise its
	// table introspection can see the same-named tables of another schema in the database.
	const migrator = new Migrator({ db, provider, migrationTableSchema: options.schema });
	const { error, results } = await migrator.migrateToLatest();
	const failed = results?.find((r) => r.status === "Error");
	if (error || failed) {
		throw new Error(`migration ${failed?.migrationName ?? "?"} failed`, { cause: error });
	}
}

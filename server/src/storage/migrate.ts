import type { Kysely } from "kysely";
import { type Migration, type MigrationProvider, Migrator } from "kysely/migration";
import * as m0001 from "./migrations/0001_init.ts";

/** Migrations are listed explicitly so they work the same from source and from a bundle. */
const migrations: Record<string, Migration> = {
	"0001_init": m0001,
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

// biome-ignore lint/suspicious/noExplicitAny: the migrator works on any schema
export async function migrateToLatest(db: Kysely<any>): Promise<void> {
	const { error, results } = await new Migrator({ db, provider }).migrateToLatest();
	const failed = results?.find((r) => r.status === "Error");
	if (error || failed) {
		throw new Error(`migration ${failed?.migrationName ?? "?"} failed`, { cause: error });
	}
}

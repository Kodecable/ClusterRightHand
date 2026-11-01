import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { PgStorage } from "../agent/pg-storage.ts";
import type { DatabaseConfig } from "../config.ts";
import { openAgentSqliteDatabase, openSqliteDialect } from "./node-sqlite.ts";
import type { Database } from "./schema.ts";

export type Db = Kysely<Database>;

export function openDb(config: DatabaseConfig): Db {
	switch (config.driver) {
		case "sqlite":
			return new Kysely<Database>({ dialect: openSqliteDialect(config.path) });
		case "postgres":
			return new Kysely<Database>({
				dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: config.url }) }),
			});
	}
}

/**
 * The agent runtime's durable storage in the same database (doc/agent-runtime.md#存储): the official SQLite
 * storage on its own connection (sharing the file's lock with Kysely's), or PgStorage on its own pool. Tables
 * carry the pi_ prefix.
 */
export async function openAgentStorage(
	config: DatabaseConfig,
): Promise<{ storage: Storage; close: () => Promise<void> }> {
	if (config.driver === "sqlite") {
		const storage = await SqliteStorage.open(await openAgentSqliteDatabase(config.path), { prefix: "pi_" });
		return {
			storage,
			close: async () => {
				await storage.close(BACKGROUND_CONTEXT);
			},
		};
	}
	const pool = new pg.Pool({ connectionString: config.url, max: 4 });
	const storage = await PgStorage.open(pool, { prefix: "pi_" });
	return {
		storage,
		close: async () => {
			await pool.end();
		},
	};
}

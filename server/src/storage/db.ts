import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import pg from "pg";
import { PgStorage } from "../agent/pg-storage.ts";
import type { DatabaseConfig } from "../config.ts";
import { openNodeSqlite } from "./node-sqlite.ts";
import type { Database } from "./schema.ts";

export type Db = Kysely<Database>;

export function openDb(config: DatabaseConfig): Db {
	switch (config.driver) {
		case "sqlite":
			return new Kysely<Database>({ dialect: new SqliteDialect({ database: openNodeSqlite(config.path) }) });
		case "postgres":
			return new Kysely<Database>({
				dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: config.url }) }),
			});
	}
}

/**
 * The agent runtime's durable storage in the same database (doc/agent-runtime.md#存储): the official SQLite
 * storage on its own connection, or PgStorage on its own pool. Tables carry the pi_ prefix.
 */
export async function openAgentStorage(
	config: DatabaseConfig,
): Promise<{ storage: Storage; close: () => Promise<void> }> {
	if (config.driver === "sqlite") {
		const storage = await openNodeSqliteStorage(config.path, { prefix: "pi_", busyTimeoutMs: 5000 });
		return { storage, close: async () => {} };
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

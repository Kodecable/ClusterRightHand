import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import pg from "pg";
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

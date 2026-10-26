import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqliteDatabase, SqliteStatement } from "kysely";

/** Adapts node:sqlite to the interface Kysely's SqliteDialect expects (modelled on better-sqlite3). */
export function openNodeSqlite(path: string): SqliteDatabase {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
	return {
		close: () => db.close(),
		prepare(sql): SqliteStatement {
			const stmt = db.prepare(sql);
			const params = (parameters: ReadonlyArray<unknown>) => parameters as SQLInputValue[];
			return {
				reader: stmt.columns().length > 0,
				all: (parameters) => stmt.all(...params(parameters)),
				run: (parameters) => stmt.run(...params(parameters)),
				iterate: (parameters) => stmt.iterate(...params(parameters)),
			};
		},
	};
}

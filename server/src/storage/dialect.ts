import { type Kysely, PostgresAdapter } from "kysely";

/** Whether `db` talks to PostgreSQL; SQLite is the only other dialect. */
export function isPostgres<DB>(db: Kysely<DB>): boolean {
	return db.getExecutor().adapter instanceof PostgresAdapter;
}

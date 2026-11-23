import { randomBytes } from "node:crypto";
import { Kysely, type KyselyPlugin, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { describe } from "vitest";
import type { Db } from "../../src/storage/db.ts";
import { migrateToLatest } from "../../src/storage/migrate.ts";
import { openSqliteDialect } from "../../src/storage/node-sqlite.ts";
import { configurePgInt8AsNumber } from "../../src/storage/pg-int8.ts";
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
		db = new Kysely<Database>({ dialect: openSqliteDialect(":memory:") });
	} else {
		const name = `t_${randomBytes(6).toString("hex")}`;
		schema = name;
		// Same parser as production, so a bigint column reads as a number here too.
		configurePgInt8AsNumber();
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
export async function withDdlLock<T>(fn: () => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: pgUrl });
	await client.connect();
	try {
		await client.query("select pg_advisory_lock(7042001)");
		return await fn();
	} finally {
		await client.end(); // releases the session-level lock
	}
}

/** Runs DDL under the lock on PostgreSQL; SQLite has no shared schemas, so it just runs the work. */
export function withDdlLockOn<T>(backend: Backend, fn: () => Promise<T>): Promise<T> {
	return backend === "postgres" ? withDdlLock(fn) : fn();
}

/**
 * Wraps a database so a user's direct node grant is deleted right after the node list that included it.
 * The terminal service reads the accessible nodes and then re-checks access; this reproduces a grant
 * revoked in that window, so the re-check is what refuses the open (not the listing's filter).
 */
export function revokeNodeGrantAfterList(db: Db, userId: string, nodeId: string): Db {
	let revoked = false;
	const nodeSelects = new WeakSet<object>();
	const plugin: KyselyPlugin = {
		transformQuery(args) {
			const node = args.node as unknown as {
				kind?: string;
				from?: { froms?: { table?: { identifier?: { name?: string } } }[] };
			};
			const table = node.from?.froms?.[0]?.table?.identifier?.name;
			if (node.kind === "SelectQueryNode" && table === "nodes") nodeSelects.add(args.queryId);
			return args.node;
		},
		async transformResult(args) {
			if (!revoked && nodeSelects.has(args.queryId) && args.result.rows.length > 0) {
				revoked = true;
				await db
					.deleteFrom("node_access_grants")
					.where("grantee_type", "=", "user")
					.where("grantee_id", "=", userId)
					.where("target_type", "=", "node")
					.where("target_id", "=", nodeId)
					.execute();
			}
			return args.result;
		},
	};
	return db.withPlugin(plugin);
}

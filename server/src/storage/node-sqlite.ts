import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqliteDatabase as AgentSqliteDatabase, SqliteValue } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	CompiledQuery,
	type DatabaseConnection,
	type Driver,
	type QueryResult,
	type SqliteDatabase,
	SqliteDialect,
	type SqliteDialectConfig,
	SqliteDriver,
	type SqliteStatement,
} from "kysely";
import { type SqliteLock, sqliteLock } from "./sqlite-lock.ts";

/** node:sqlite waits this long for another process's lock; in process the queue is what serializes writers. */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * How many prepared statements one connection keeps. Every distinct `IN (?, ?, …)` length produces another
 * text, so an unbounded cache would follow list sizes forever; 256 covers the statements a request path
 * repeats, and an evicted text is simply prepared again.
 */
export const PREPARED_STATEMENT_CACHE_LIMIT = 256;

/** Adapts node:sqlite to the interface Kysely's SqliteDialect expects (modelled on better-sqlite3). */
export function openNodeSqlite(path: string): SqliteDatabase {
	const db = new DatabaseSync(path);
	// The same WAL durability settings as chord's durable connection (openNodeSqliteDatabase): WAL + NORMAL
	// survives a process crash, and a power loss can drop the last committed transactions but cannot corrupt
	// the database. The default, FULL, made every business commit wait for an fsync.
	db.exec(
		`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
	);
	// Kysely prepares every statement it runs; a query text is prepared once and reused, as the agent
	// storage's own adapter does. The map is an LRU: a hit is re-inserted so Map's insertion order stays
	// least-recently-used first, and inserting past the cap drops the oldest reference. An evicted statement is
	// not closed: a stream may still be iterating it, and node:sqlite closes its statements with the database.
	const statements = new Map<string, SqliteStatement>();
	const params = (parameters: ReadonlyArray<unknown>) => parameters as SQLInputValue[];
	return {
		close: () => {
			statements.clear();
			db.close();
		},
		prepare(sql): SqliteStatement {
			const cached = statements.get(sql);
			if (cached) {
				statements.delete(sql);
				statements.set(sql, cached);
				return cached;
			}
			const stmt = db.prepare(sql);
			const prepared: SqliteStatement = {
				reader: stmt.columns().length > 0,
				all: (parameters) => stmt.all(...params(parameters)),
				run: (parameters) => stmt.run(...params(parameters)),
				iterate: (parameters) => stmt.iterate(...params(parameters)),
			};
			if (statements.size >= PREPARED_STATEMENT_CACHE_LIMIT) {
				const oldest = statements.keys().next();
				if (!oldest.done) statements.delete(oldest.value);
			}
			statements.set(sql, prepared);
			return prepared;
		},
	};
}

/**
 * Kysely's dialect for a SQLite database file: every statement shares the file's lock with the agent storage
 * (see SqliteLock), so the two connections never contend for SQLite's write lock.
 */
export function openSqliteDialect(path: string): SqliteDialect {
	return new LockedSqliteDialect({ database: openNodeSqlite(path) }, sqliteLock(path));
}

/**
 * pi-durable's database handle for a SQLite file, on the same lock as Kysely. A transaction keeps the lock
 * until it commits or rolls back; its handle then runs the statements directly, as chord expects.
 */
export async function openAgentSqliteDatabase(path: string): Promise<AgentSqliteDatabase> {
	const lock = sqliteLock(path);
	const database = await lock.run(() => openNodeSqliteDatabase(path, { busyTimeoutMs: BUSY_TIMEOUT_MS }));
	return {
		exec: (sql) => lock.run(() => database.exec(sql)),
		run: (sql, ...parameters) => lock.run(() => database.run(sql, ...parameters)),
		get: <T extends object>(sql: string, ...parameters: SqliteValue[]) =>
			lock.run(() => database.get<T>(sql, ...parameters)),
		all: <T extends object>(sql: string, ...parameters: SqliteValue[]) =>
			lock.run(() => database.all<T>(sql, ...parameters)),
		transaction: (callback) => lock.run(() => database.transaction(callback)),
		close: () => lock.run(() => database.close()),
	};
}

class LockedSqliteDialect extends SqliteDialect {
	readonly #lock: SqliteLock;
	readonly #config: SqliteDialectConfig;

	constructor(config: SqliteDialectConfig, lock: SqliteLock) {
		super(config);
		this.#config = config;
		this.#lock = lock;
	}

	override createDriver(): Driver {
		return new LockedSqliteDriver(this.#config, this.#lock);
	}
}

/**
 * Kysely's SQLite driver with the file's lock: a statement waits for its turn, and a transaction holds the
 * lock from its `BEGIN IMMEDIATE` to its `COMMIT` or `ROLLBACK`. IMMEDIATE is what the lock needs: a deferred
 * transaction that read before writing would take its write lock late, and every statement in the transaction
 * has to be able to run while the lock is held (it would deadlock through the queue).
 */
class LockedSqliteDriver extends SqliteDriver {
	readonly #lock: SqliteLock;
	/** Set while this driver's transaction holds the lock; its statements then run directly. */
	#release: (() => void) | undefined;

	constructor(config: SqliteDialectConfig, lock: SqliteLock) {
		super(config);
		this.#lock = lock;
	}

	override async acquireConnection(): Promise<DatabaseConnection> {
		return new LockedSqliteConnection(await super.acquireConnection(), this.#lock, () => this.#release !== undefined);
	}

	override async beginTransaction(connection: DatabaseConnection): Promise<void> {
		const release = await this.#lock.hold();
		this.#release = release;
		try {
			await connection.executeQuery(CompiledQuery.raw("begin immediate"));
		} catch (err) {
			this.#release = undefined;
			release();
			throw err;
		}
	}

	override async commitTransaction(connection: DatabaseConnection): Promise<void> {
		try {
			await connection.executeQuery(CompiledQuery.raw("commit"));
		} finally {
			this.#endTransaction();
		}
	}

	override async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
		try {
			await connection.executeQuery(CompiledQuery.raw("rollback"));
		} finally {
			this.#endTransaction();
		}
	}

	override async destroy(): Promise<void> {
		await this.#lock.run(() => super.destroy());
	}

	#endTransaction(): void {
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}
}

/** A connection whose statements take the file's lock, except inside the transaction that holds it. */
class LockedSqliteConnection implements DatabaseConnection {
	readonly #connection: DatabaseConnection;
	readonly #lock: SqliteLock;
	readonly #inTransaction: () => boolean;

	constructor(connection: DatabaseConnection, lock: SqliteLock, inTransaction: () => boolean) {
		this.#connection = connection;
		this.#lock = lock;
		this.#inTransaction = inTransaction;
	}

	executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		if (this.#inTransaction()) return this.#connection.executeQuery(compiledQuery);
		return this.#lock.run(() => this.#connection.executeQuery(compiledQuery));
	}

	async *streamQuery<R>(compiledQuery: CompiledQuery, chunkSize: number): AsyncIterableIterator<QueryResult<R>> {
		if (this.#inTransaction()) {
			yield* this.#connection.streamQuery<R>(compiledQuery, chunkSize);
			return;
		}
		const release = await this.#lock.hold();
		try {
			yield* this.#connection.streamQuery<R>(compiledQuery, chunkSize);
		} finally {
			release();
		}
	}
}

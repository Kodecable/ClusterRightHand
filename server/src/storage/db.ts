import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DatabaseConfig } from "../config.ts";
import { openAgentSqliteDatabase, openSqliteDialect } from "./node-sqlite.ts";
import { PgStorage } from "./pg-durable/index.ts";
import type { Database } from "./schema.ts";

export type Db = Kysely<Database>;

/** An open agent storage and the close that releases it; a second close is a no-op. */
export interface OpenedAgentStorage {
	storage: Storage;
	close: () => Promise<void>;
}

/**
 * Keeps the close of the agent runtime's current storage. Opening first closes the previous storage;
 * the close is swapped for a no-op before it runs, so an open that fails leaves nothing to close again
 * and the next attempt starts from scratch.
 */
export function createStorageOpener(open: () => Promise<OpenedAgentStorage>): {
	open: () => Promise<Storage>;
	close: () => Promise<void>;
} {
	let close = async () => {};
	return {
		async open() {
			const previous = close;
			close = async () => {};
			await previous();
			const opened = await open();
			close = opened.close;
			return opened.storage;
		},
		async close() {
			const current = close;
			close = async () => {};
			await current();
		},
	};
}

/** Wraps a close so a second call returns at once instead of releasing the storage twice. */
function closeOnce(close: () => Promise<void>): () => Promise<void> {
	let closed = false;
	return async () => {
		if (closed) return;
		closed = true;
		await close();
	};
}

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
 * The agent runtime's durable storage in the same database (doc/design/agent-runtime.md "Storage"): the official SQLite
 * storage on its own connection (sharing the file's lock with Kysely's), or PgStorage on its own pool. Tables
 * carry the pi_ prefix.
 */
export async function openAgentStorage(config: DatabaseConfig): Promise<OpenedAgentStorage> {
	if (config.driver === "sqlite") {
		const storage = await SqliteStorage.open(await openAgentSqliteDatabase(config.path), { prefix: "pi_" });
		return {
			storage,
			close: closeOnce(async () => {
				await storage.close(BACKGROUND_CONTEXT);
			}),
		};
	}
	const pool = new pg.Pool({ connectionString: config.url, max: 4 });
	let storage: PgStorage;
	try {
		storage = await PgStorage.open(pool, { prefix: "pi_" });
	} catch (error) {
		// The pool belongs to this function: an open that failed must not leak it.
		try {
			await pool.end();
		} catch {
			// Preserve the initialization failure.
		}
		throw error;
	}
	return {
		storage,
		close: closeOnce(async () => {
			// Release the ownership lock connection before the pool the storage's queries use.
			try {
				await storage.close(BACKGROUND_CONTEXT);
			} finally {
				await pool.end();
			}
		}),
	};
}

import type { SqliteDatabase, SqliteStatement } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqlite, PREPARED_STATEMENT_CACHE_LIMIT } from "../src/storage/node-sqlite.ts";

const opened: SqliteDatabase[] = [];

function memoryDb(): SqliteDatabase {
	const db = openNodeSqlite(":memory:");
	opened.push(db);
	return db;
}

afterEach(() => {
	for (const db of opened.splice(0)) db.close();
});

describe("openNodeSqlite prepared statement cache", () => {
	it("moves a hit to most-recent and evicts the least recently used text past the cap", () => {
		const db = memoryDb();
		const first = db.prepare("select 'first' as x");
		const second = db.prepare("select 'second' as x");
		for (let i = 0; i < PREPARED_STATEMENT_CACHE_LIMIT - 2; i++) db.prepare(`select ${i} as x`);
		// A hit is moved to most-recent, so `second` stays while `first` becomes the oldest.
		expect(db.prepare("select 'second' as x")).toBe(second);
		db.prepare("select 'new' as x");

		expect(db.prepare("select 'second' as x")).toBe(second);
		expect(db.prepare("select 'first' as x")).not.toBe(first);
	});

	it("keeps the newest entries and drops the oldest past the cap", () => {
		const db = memoryDb();
		const sql = (i: number) => `select ${i} as x`;
		const prepared: SqliteStatement[] = [];
		for (let i = 0; i < PREPARED_STATEMENT_CACHE_LIMIT + 10; i++) prepared.push(db.prepare(sql(i)));

		// Re-preparing the ten oldest texts is a miss and pushes out the next ten; a recent text is still cached.
		for (let i = 0; i < 10; i++) expect(db.prepare(sql(i))).not.toBe(prepared[i]);
		expect(db.prepare(sql(PREPARED_STATEMENT_CACHE_LIMIT + 9))).toBe(prepared.at(-1));
	});
});

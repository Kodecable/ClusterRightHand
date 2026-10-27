import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, Storage } from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { PgStorage } from "../src/agent/pg-storage.ts";

const pgUrl = process.env.CRH_TEST_PG_URL;
const context = BACKGROUND_CONTEXT;
const ROOT = 1 as ConversationId;

/** Same lock as test/helpers/db.ts: Kysely's migrator in parallel test files breaks if a schema vanishes mid-run. */
async function withDdlLock<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: pgUrl });
	await client.connect();
	try {
		await client.query("select pg_advisory_lock(7042001)");
		return await fn(client);
	} finally {
		await client.end();
	}
}

/** A fresh PostgreSQL schema and a pool whose search_path points at it; dropped afterwards. */
async function withSchema(use: (pool: pg.Pool, schema: string) => Promise<void>): Promise<void> {
	const schema = `t_${randomBytes(6).toString("hex")}`;
	await withDdlLock((client) => client.query(`create schema "${schema}"`));
	const pool = new pg.Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` });
	try {
		await use(pool, schema);
	} finally {
		await pool.end();
		await withDdlLock((client) => client.query(`drop schema "${schema}" cascade`));
	}
}

async function withOpen<T>(storage: Storage, use: (storage: Storage) => Promise<T>): Promise<T> {
	try {
		return await use(storage);
	} finally {
		await storage.close(context);
	}
}

const suite = pgUrl ? describe : describe.skip;

suite("PgStorage", () => {
	registerStorageConformance({ describe, expect, it }, "conformance", (use) =>
		withSchema(async (pool) => withOpen(await PgStorage.open(pool, {}), use)),
	);

	it("refuses a second owner while the first is open and admits one after close", () =>
		withSchema(async (pool, schema) => {
			const first = await PgStorage.open(pool, {});
			// An explicit schema resolves to the same storage as the search_path default.
			await expect(PgStorage.open(pool, { schema })).rejects.toThrow("already open");
			const otherPool = new pg.Pool({ connectionString: pgUrl });
			try {
				await expect(PgStorage.open(otherPool, { schema })).rejects.toThrow("already open");
			} finally {
				await otherPool.end();
			}
			await first.close(context);
			const second = await PgStorage.open(pool, { schema });
			await second.close(context);
		}));

	it("keeps data across reopen and mints IDs above everything stored before", () =>
		withSchema(async (pool) => {
			const minted: number[] = [];
			await withOpen(await PgStorage.open(pool, {}), async (storage) => {
				expect(await storage.mintId()).toBe(2);
				await storage.commit([{ type: "conversation", value: { id: ROOT } }], context);
				const entryId = await storage.mintId<EntryId>();
				minted.push(entryId);
				await storage.commit(
					[
						{
							type: "entry",
							value: { id: entryId, conversationId: ROOT, kind: "message", data: { text: "hi" } },
						},
					],
					context,
				);
				// Minted but never stored; the next commit persists the counter past it.
				minted.push(await storage.mintId());
				await storage.commit(
					[
						{
							type: "entry",
							value: { id: 500 as EntryId, conversationId: ROOT, kind: "message", data: {} },
						},
					],
					context,
				);
			});
			await withOpen(await PgStorage.open(pool, {}), async (storage) => {
				expect(await storage.conversation(ROOT, context)).toEqual({ id: ROOT });
				const stored = await storage.entry(minted[0] as EntryId, context);
				expect(stored?.entry).toMatchObject({ id: minted[0], data: { text: "hi" } });
				expect(stored?.commitSeq).toBe(2);
				expect(await storage.mintId()).toBe(501);
				// An empty commit still persists the minted counter.
				expect(await storage.commit([], context)).toBe(4);
			});
			await withOpen(await PgStorage.open(pool, {}), async (storage) => {
				expect(await storage.mintId()).toBe(502);
			});
		}));

	it("isolates storages with different prefixes in one schema", () =>
		withSchema(async (pool, schema) => {
			const a = await PgStorage.open(pool, { schema, prefix: "a_" });
			const b = await PgStorage.open(pool, { schema, prefix: "b_" });
			try {
				await a.commit([{ type: "conversation", value: { id: ROOT } }], context);
				await a.commit([{ type: "conversation", value: { id: 7 as ConversationId } }], context);
				expect(await a.conversation(ROOT, context)).toEqual({ id: ROOT });
				expect(await b.conversation(ROOT, context)).toBeUndefined();
				expect(await b.mintId()).toBe(2);
				expect(await b.commit([], context)).toBe(1);
				await b.commit([{ type: "conversation", value: { id: ROOT } }], context);
			} finally {
				await a.close(context);
				await b.close(context);
			}
			const { rows } = await pool.query<{ table_name: string }>(
				"select table_name from information_schema.tables where table_schema = $1 order by table_name",
				[schema],
			);
			const names = rows.map((row) => row.table_name);
			expect(names.filter((name) => name.startsWith("a_"))).toHaveLength(9);
			expect(names.filter((name) => name.startsWith("b_"))).toHaveLength(9);
			expect(names).toHaveLength(18);
		}));

	it("rejects invalid prefixes", async () => {
		const pool = new pg.Pool({ connectionString: pgUrl });
		try {
			await expect(PgStorage.open(pool, { prefix: 'x"; drop' })).rejects.toThrow("Invalid PgStorage prefix");
			await expect(PgStorage.open(pool, { prefix: "p".repeat(40) })).rejects.toThrow("too long");
		} finally {
			await pool.end();
		}
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openAgentStorage, openDb } from "../src/storage/db.ts";
import { migrateToLatest } from "../src/storage/migrate.ts";

/**
 * crhs opens one SQLite file twice: Kysely for its own tables and pi-durable's storage for the agent
 * runtime (doc/data-model.md). node:sqlite is synchronous, so the two connections cannot contend
 * for the write lock without stalling each other: a deferred transaction that read and then writes
 * fails at once with SQLITE_BUSY_SNAPSHOT, and SQLite's busy handler blocks the very thread that has to
 * commit the other transaction. Both must be serialized in process.
 */

const context = BACKGROUND_CONTEXT;
const conversation = (id: number) => [{ type: "conversation" as const, value: { id: id as ConversationId } }];

describe("SQLite connections", () => {
	let dir = "";
	let path = "";
	let db: Db;
	let storage: Awaited<ReturnType<typeof openAgentStorage>>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "crh-sqlite-lock-"));
		path = join(dir, "crhs.db");
		db = openDb({ driver: "sqlite", path });
		await migrateToLatest(db);
		storage = await openAgentStorage({ driver: "sqlite", path });
		await sql`create table lock_probe (id integer primary key, v text)`.execute(db);
	});

	afterEach(async () => {
		await storage.close();
		await db.destroy();
		await rm(dir, { recursive: true, force: true });
	});

	const probeRows = async () =>
		(await sql<{ v: string }>`select v from lock_probe order by id`.execute(db)).rows.map((row) => row.v);

	it("lets a read-then-write transaction commit while the agent storage writes", async () => {
		// A deferred BEGIN reads first and then upgrades to a write: with another writer's commit in
		// between, SQLite answers SQLITE_BUSY_SNAPSHOT at once and no busy timeout applies.
		const transaction = db.transaction().execute(async (trx) => {
			await sql`select count(*) from lock_probe`.execute(trx);
			// A real await between the read and the write, as a transaction body may have.
			await sleep(20);
			await sql`insert into lock_probe (v) values ('kysely')`.execute(trx);
		});
		const committed = storage.storage.commit(conversation(1), context);
		await expect(Promise.all([transaction, committed])).resolves.toBeDefined();
		expect(await probeRows()).toEqual(["kysely"]);
	});

	it("keeps the agent storage's commit off the Kysely transaction's lock instead of the busy timeout", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transaction = db.transaction().execute(async (trx) => {
			await sql`insert into lock_probe (v) values ('kysely')`.execute(trx);
			await gate;
			await sql`insert into lock_probe (v) values ('kysely-2')`.execute(trx);
		});
		// Let the transaction take the write lock before the storage starts its own.
		await sleep(10);
		const started = Date.now();
		const committed = storage.storage.commit(conversation(2), context);
		await sleep(50);
		release();
		await expect(committed).resolves.toBeGreaterThan(0);
		await transaction;
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(await probeRows()).toEqual(["kysely", "kysely-2"]);
	});

	it("runs the server's own writes and the agent storage's writes side by side", async () => {
		const rounds = 20;
		const writes = Array.from({ length: rounds }, (_, index) =>
			db.transaction().execute(async (trx) => {
				await sql`select count(*) from lock_probe`.execute(trx);
				await sql`insert into lock_probe (v) values (${`kysely-${index}`})`.execute(trx);
			}),
		);
		const commits = Array.from({ length: rounds }, (_, index) =>
			storage.storage.commit(conversation(100 + index), context),
		);
		await Promise.all([...writes, ...commits]);
		expect(await probeRows()).toHaveLength(rounds);
	});
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A PostgreSQL pool is an EventEmitter: an idle client error (a restart, idle_session_timeout,
 * pg_terminate_backend, a reset) is emitted as 'error', and without a listener Node throws it as an
 * uncaught exception. Both pools crhs opens attach one that logs (db.ts).
 */
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAgentStorage, openDb } from "../src/storage/db.ts";
import { PgStorage } from "../src/storage/pg-durable/index.ts";

// Nothing connects: pg.Pool is lazy, and the agent storage's open is replaced below.
const URL = "postgres://user:password@127.0.0.1:1/crh";

describe("PostgreSQL pool errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logs an idle client error on the Kysely pool instead of throwing", async () => {
		const on = vi.spyOn(pg.Pool.prototype, "on");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const db = openDb({ driver: "postgres", url: URL });
		try {
			const pool = on.mock.instances.at(-1) as pg.Pool;
			expect(pool.listenerCount("error")).toBe(1);
			expect(() => pool.emit("error", new Error("idle client died"))).not.toThrow();
			expect(log).toHaveBeenCalledWith("postgres pool:", expect.any(Error));
		} finally {
			await db.destroy();
		}
	});

	it("logs an idle client error on the agent storage pool instead of throwing", async () => {
		const on = vi.spyOn(pg.Pool.prototype, "on");
		vi.spyOn(PgStorage, "open").mockResolvedValue({ close: async () => {} } as unknown as PgStorage);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const opened = await openAgentStorage({ driver: "postgres", url: URL });
		try {
			const pool = on.mock.instances.at(-1) as pg.Pool;
			expect(pool.listenerCount("error")).toBe(1);
			expect(() => pool.emit("error", new Error("idle client died"))).not.toThrow();
			expect(log).toHaveBeenCalledWith("postgres pool:", expect.any(Error));
		} finally {
			await opened.close();
		}
	});
});

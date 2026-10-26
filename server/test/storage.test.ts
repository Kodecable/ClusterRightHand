import { describe, expect, it } from "vitest";
import type { DatabaseConfig } from "../src/config.ts";
import { openDb } from "../src/storage/db.ts";
import { migrateToLatest } from "../src/storage/migrate.ts";

const backends: [string, DatabaseConfig | undefined][] = [
	["sqlite", { driver: "sqlite", path: ":memory:" }],
	["postgres", process.env.CRH_TEST_PG_URL ? { driver: "postgres", url: process.env.CRH_TEST_PG_URL } : undefined],
];

describe.each(backends)("storage on %s", (_name, config) => {
	it.skipIf(!config)("migrates and round-trips a user", async () => {
		const db = openDb(config as DatabaseConfig);
		try {
			await migrateToLatest(db);
			await migrateToLatest(db); // idempotent
			const now = new Date().toISOString();
			await db.insertInto("orgs").values({ id: "o1", name: "default", created_at: now }).execute();
			await db
				.insertInto("users")
				.values({
					id: "u1",
					org_id: "o1",
					username: "admin",
					display_name: "Admin",
					email: null,
					kind: "admin",
					password_hash: null,
					status: "active",
					created_at: now,
				})
				.execute();
			const user = await db.selectFrom("users").selectAll().where("username", "=", "admin").executeTakeFirstOrThrow();
			expect(user).toMatchObject({ id: "u1", kind: "admin", password_hash: null });
			await expect(
				db
					.insertInto("users")
					.values({ ...user, id: "u2" })
					.execute(),
			).rejects.toThrow();
		} finally {
			await db.destroy();
		}
	});
});

import { afterEach, beforeEach, expect, it } from "vitest";
import type { Db } from "../src/storage/db.ts";
import { migrateToLatest } from "../src/storage/migrate.ts";
import { describeBackends, openTestDb, withDdlLockOn } from "./helpers/db.ts";

describeBackends("storage", (backend) => {
	let db: Db;
	beforeEach(async () => {
		db = await openTestDb(backend);
	});
	afterEach(async () => {
		await db.destroy();
	});

	it("migrates idempotently and round-trips a user", async () => {
		// The migrator introspects every schema, so a parallel test dropping its schema must not run now.
		await withDdlLockOn(backend, () => migrateToLatest(db));
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
	});

	async function seedOrgAndUsers(): Promise<void> {
		const now = new Date().toISOString();
		await db.insertInto("orgs").values({ id: "o1", name: "default", created_at: now }).execute();
		for (const id of ["u1", "u2"]) {
			await db
				.insertInto("users")
				.values({
					id,
					org_id: "o1",
					username: id,
					display_name: id,
					email: null,
					kind: "member",
					password_hash: null,
					status: "active",
					created_at: now,
				})
				.execute();
		}
	}

	async function insertGroup(id: string, name: string): Promise<void> {
		await db
			.insertInto("user_groups")
			.values({ id, org_id: "o1", name, source: "local", created_at: new Date().toISOString() })
			.execute();
	}

	function sessionRow(id: string, tokenHash: string, userId: string) {
		const now = new Date().toISOString();
		return {
			id,
			token_hash: tokenHash,
			user_id: userId,
			created_at: now,
			expires_at: now,
			last_seen_at: now,
			ip: null,
			user_agent: null,
		};
	}

	function shareRow(id: string, granteeId = "u2") {
		return {
			id,
			org_id: "o1",
			resource_type: "session" as const,
			resource_id: "n1",
			grantee_type: "user" as const,
			grantee_id: granteeId,
			access: "view" as const,
			created_by_user_id: "u1",
			created_at: new Date().toISOString(),
		};
	}

	it("stores group members and cascades when the user is deleted", async () => {
		await seedOrgAndUsers();
		await insertGroup("g1", "ops");
		const now = new Date().toISOString();
		await db
			.insertInto("user_group_members")
			.values([
				{ user_group_id: "g1", user_id: "u1", created_at: now },
				{ user_group_id: "g1", user_id: "u2", created_at: now },
			])
			.execute();
		await expect(
			db.insertInto("user_group_members").values({ user_group_id: "g1", user_id: "u1", created_at: now }).execute(),
		).rejects.toThrow();
		await db.deleteFrom("users").where("id", "=", "u2").execute();
		const rows = await db.selectFrom("user_group_members").selectAll().execute();
		expect(rows.map((r) => r.user_id)).toEqual(["u1"]);
	});

	it("enforces unique group names per org", async () => {
		await seedOrgAndUsers();
		await insertGroup("g1", "ops");
		await expect(insertGroup("g2", "ops")).rejects.toThrow();
		await insertGroup("g3", "dev");
	});

	it("enforces unique web session tokens and cascades on user delete", async () => {
		await seedOrgAndUsers();
		await db
			.insertInto("web_sessions")
			.values(sessionRow("s1", "hash1", "u1"))
			.execute();
		await expect(
			db
				.insertInto("web_sessions")
				.values(sessionRow("s2", "hash1", "u2"))
				.execute(),
		).rejects.toThrow();
		await db
			.insertInto("web_sessions")
			.values(sessionRow("s3", "hash3", "u2"))
			.execute();
		await db.deleteFrom("users").where("id", "=", "u1").execute();
		const rows = await db.selectFrom("web_sessions").selectAll().execute();
		expect(rows.map((r) => r.id)).toEqual(["s3"]);
	});

	it("enforces unique shares per resource and grantee", async () => {
		await seedOrgAndUsers();
		await db.insertInto("shares").values(shareRow("sh1")).execute();
		await expect(db.insertInto("shares").values(shareRow("sh2")).execute()).rejects.toThrow();
		await db.insertInto("shares").values(shareRow("sh3", "u1")).execute();
		await db
			.insertInto("shares")
			.values({ ...shareRow("sh4"), resource_id: "s1", access: "chat" })
			.execute();
	});
});

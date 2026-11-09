import type { UserDetail, UserGroupDetail } from "@crh/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/storage/db.ts";
import { createUser, type PublicUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describeBackends("api users", (backend) => {
	let db: Db;
	let app: App;
	let admin: string;
	let adminId: string;

	const users = async () =>
		((await (await call(app, "/api/users", { cookie: admin })).json()) as { users: PublicUser[] }).users;
	const byName = async (name: string) => {
		const u = (await users()).find((x) => x.username === name);
		if (!u) throw new Error(`no user ${name}`);
		return u;
	};
	const patch = (id: string, body: unknown) => call(app, `/api/users/${id}`, { method: "PATCH", cookie: admin, body });

	beforeAll(async () => {
		db = await openTestDb(backend);
		app = makeApp(db);
		adminId = (await createUser(db, { username: "root", kind: "admin", password: "root-password" })).id;
		admin = await login(app, "root", "root-password");
	});
	afterAll(async () => {
		await db.destroy();
	});

	describe("users", () => {
		it("creates a user with defaults and a normalized username", async () => {
			const res = await call(app, "/api/users", { cookie: admin, body: { username: "  Carol.Smith " } });
			expect(res.status).toBe(201);
			const { user } = (await res.json()) as { user: Record<string, unknown> };
			expect(user).toMatchObject({
				username: "carol.smith",
				displayName: "carol.smith",
				kind: "member",
				status: "active",
				email: null,
			});
			expect(user).not.toHaveProperty("password_hash");
			expect((await users()).map((u) => u.username)).toContain("carol.smith");
		});

		it("creates an admin with display name and email", async () => {
			const res = await call(app, "/api/users", {
				cookie: admin,
				body: { username: "dave", kind: "admin", displayName: "Dave D", email: "dave@example.com" },
			});
			expect(res.status).toBe(201);
			expect(((await res.json()) as { user: unknown }).user).toMatchObject({
				kind: "admin",
				displayName: "Dave D",
				email: "dave@example.com",
			});
		});

		it("rejects duplicates (case-insensitively), bad kind, short password, bad username, wrong types", async () => {
			const dup = await call(app, "/api/users", { cookie: admin, body: { username: "CAROL.SMITH" } });
			expect(dup.status).toBe(400);
			expect(((await dup.json()) as { error: string }).error).toMatch(/already exists/);
			expect((await call(app, "/api/users", { cookie: admin, body: { username: "x2", kind: "root" } })).status).toBe(
				400,
			);
			expect(
				(await call(app, "/api/users", { cookie: admin, body: { username: "x3", password: "short" } })).status,
			).toBe(400);
			expect((await call(app, "/api/users", { cookie: admin, body: { username: "bad name!" } })).status).toBe(400);
			expect((await call(app, "/api/users", { cookie: admin, body: {} })).status).toBe(400);
			expect((await call(app, "/api/users", { cookie: admin, body: { username: 5 } })).status).toBe(400);
			expect((await call(app, "/api/users", { cookie: admin, body: [] })).status).toBe(400);
			const names = (await users()).map((u) => u.username);
			expect(names).not.toContain("x2");
			expect(names).not.toContain("x3");
		});

		it("a user created with a password can log in", async () => {
			const res = await call(app, "/api/users", {
				cookie: admin,
				body: { username: "erin", password: "erin-password" },
			});
			expect(res.status).toBe(201);
			expect(JSON.stringify(await res.json())).not.toContain("erin-password");
			expect((await login(app, "erin", "erin-password")).startsWith("crh_session=")).toBe(true);
		});

		it("PATCH changes displayName, kind and email", async () => {
			const u = await byName("carol.smith");
			const res = await patch(u.id, { displayName: " Carol S ", kind: "admin", email: "c@example.com" });
			expect(res.status).toBe(200);
			expect(((await res.json()) as { user: unknown }).user).toMatchObject({
				displayName: "Carol S",
				kind: "admin",
				email: "c@example.com",
			});
			expect(await byName("carol.smith")).toMatchObject({ displayName: "Carol S", kind: "admin" });
			const cleared = await patch(u.id, { email: null, kind: "member" });
			expect(((await cleared.json()) as { user: unknown }).user).toMatchObject({ email: null, kind: "member" });
		});

		it("PATCH validates kind, status and types", async () => {
			const u = await byName("carol.smith");
			expect((await patch(u.id, { kind: "god" })).status).toBe(400);
			expect((await patch(u.id, { status: "gone" })).status).toBe(400);
			expect((await patch(u.id, { displayName: 5 })).status).toBe(400);
			expect((await patch(u.id, [])).status).toBe(400);
		});

		it("PATCH rejects a display name that is empty after trimming", async () => {
			const created = await call(app, "/api/users", { cookie: admin, body: { username: "blank-name" } });
			const id = ((await created.json()) as { user: { id: string } }).user.id;
			const res = await patch(id, { displayName: " \t " });
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(/displayName/);
			expect((await byName("blank-name")).displayName).toBe("blank-name");
		});

		it("PATCH of an unknown user is a 404", async () => {
			const res = await patch("does-not-exist", { displayName: "x" });
			expect(res.status).toBe(404);
		});

		it("cannot demote or disable the last active admin; data is unchanged", async () => {
			// make dave and carol non-admins / disabled so root is the only active admin
			const dave = await byName("dave");
			expect((await patch(dave.id, { status: "disabled" })).status).toBe(200);
			expect((await byName("dave")).status).toBe("disabled");

			const demote = await patch(adminId, { kind: "member" });
			expect(demote.status).toBe(400);
			expect(((await demote.json()) as { error: string }).error).toMatch(/administrator/);
			const disable = await patch(adminId, { status: "disabled", displayName: "changed" });
			expect(disable.status).toBe(400);

			const root = await byName("root");
			expect(root).toMatchObject({ kind: "admin", status: "active", displayName: "root" });
			// the rejected disable must not have revoked the session
			expect((await call(app, "/api/me", { cookie: admin })).status).toBe(200);
		});

		it("a disabled admin does not count as active; another active admin allows demotion", async () => {
			const dave = await byName("dave");
			expect((await patch(dave.id, { status: "active" })).status).toBe(200);
			expect((await patch(dave.id, { kind: "member" })).status).toBe(200);
			expect((await patch(dave.id, { kind: "admin" })).status).toBe(200);
		});

		it("disabling a user invalidates their sessions", async () => {
			await createUser(db, { username: "frank", kind: "member", password: "frank-password" });
			const cookie = await login(app, "frank", "frank-password");
			expect((await call(app, "/api/me", { cookie })).status).toBe(200);
			const frank = await byName("frank");
			expect((await patch(frank.id, { status: "disabled" })).status).toBe(200);
			expect((await call(app, "/api/me", { cookie })).status).toBe(401);
			// re-enabling does not resurrect the old session
			expect((await patch(frank.id, { status: "active" })).status).toBe(200);
			expect((await call(app, "/api/me", { cookie })).status).toBe(401);
			expect((await login(app, "frank", "frank-password")).length).toBeGreaterThan(0);
		});

		it("an admin who is demoted keeps a session but loses admin access", async () => {
			await createUser(db, { username: "gina", kind: "admin", password: "gina-password" });
			const cookie = await login(app, "gina", "gina-password");
			expect((await call(app, "/api/users", { cookie })).status).toBe(200);
			const gina = await byName("gina");
			expect((await patch(gina.id, { kind: "member" })).status).toBe(200);
			expect((await call(app, "/api/users", { cookie })).status).toBe(403);
		});

		it("admin password reset revokes that user's sessions and swaps the password", async () => {
			await createUser(db, { username: "hank", kind: "member", password: "hank-password" });
			const cookie = await login(app, "hank", "hank-password");
			const hank = await byName("hank");
			const res = await call(app, `/api/users/${hank.id}/password`, {
				cookie: admin,
				body: { password: "hank-new-pass" },
			});
			expect(res.status).toBe(200);
			expect((await call(app, "/api/me", { cookie })).status).toBe(401);
			expect(
				(await call(app, "/api/auth/login", { body: { username: "hank", password: "hank-password" } })).status,
			).toBe(401);
			expect((await login(app, "hank", "hank-new-pass")).length).toBeGreaterThan(0);
			// admin's own session is untouched
			expect((await call(app, "/api/me", { cookie: admin })).status).toBe(200);
		});

		it("password reset validates input and the target", async () => {
			const hank = await byName("hank");
			expect((await call(app, `/api/users/${hank.id}/password`, { cookie: admin, body: {} })).status).toBe(400);
			expect(
				(await call(app, `/api/users/${hank.id}/password`, { cookie: admin, body: { password: "short" } })).status,
			).toBe(400);
			expect(
				(await call(app, "/api/users/nope/password", { cookie: admin, body: { password: "long-enough-1" } })).status,
			).toBe(404);
		});

		it("admin can set a first password for a passwordless user", async () => {
			const u = await byName("carol.smith");
			expect(
				(await call(app, `/api/users/${u.id}/password`, { cookie: admin, body: { password: "carol-pass-1" } })).status,
			).toBe(200);
			expect((await login(app, "carol.smith", "carol-pass-1")).length).toBeGreaterThan(0);
		});
	});

	describe("user detail", () => {
		const detail = (id: string, cookie: string) => call(app, `/api/users/${id}`, { cookie });

		it("an administrator reads any user with the groups it belongs to", async () => {
			const erin = await byName("erin");
			const created = await call(app, "/api/user-groups", { cookie: admin, body: { name: "detail-team" } });
			const group = ((await created.json()) as { group: { id: string; name: string } }).group;
			expect(
				(
					await call(app, `/api/user-groups/${group.id}/members/${erin.id}`, {
						method: "PUT",
						cookie: admin,
						body: {},
					})
				).status,
			).toBe(200);

			const res = await detail(erin.id, admin);
			expect(res.status).toBe(200);
			const body = (await res.json()) as UserDetail;
			expect(body.user).toMatchObject({ id: erin.id, username: "erin", kind: "member" });
			expect(body.user).not.toHaveProperty("password_hash");
			expect(body.userGroups).toEqual([{ id: group.id, name: "detail-team" }]);
		});

		it("a member reads only themselves; every other id is the missing-user 404", async () => {
			const erin = await byName("erin");
			const erinCookie = await login(app, "erin", "erin-password");
			const own = await detail(erin.id, erinCookie);
			expect(own.status).toBe(200);
			expect(((await own.json()) as UserDetail).user.username).toBe("erin");

			const other = await detail(adminId, erinCookie);
			const missing = await detail("does-not-exist", erinCookie);
			expect(other.status).toBe(404);
			expect(missing.status).toBe(404);
			expect(((await other.json()) as { error: string }).error).toBe(
				((await missing.json()) as { error: string }).error,
			);
			// The list stays administrators-only; only the detail endpoint admits the self case.
			expect((await call(app, "/api/users", { cookie: erinCookie })).status).toBe(403);
			expect(
				(await call(app, `/api/users/${erin.id}/password`, { cookie: erinCookie, body: { password: "long-enough-1" } }))
					.status,
			).toBe(403);
		});

		it("a missing user is the same 404 for an administrator", async () => {
			expect((await detail("does-not-exist", admin)).status).toBe(404);
			expect(
				(((await (await detail("does-not-exist", admin)).json()) as { error: string }).error ?? "").length,
			).toBeGreaterThan(0);
		});
	});

	describe("user groups", () => {
		const groups = async () =>
			(
				(await (await call(app, "/api/user-groups", { cookie: admin })).json()) as {
					groups: { id: string; name: string; memberIds: string[]; source: string }[];
				}
			).groups;

		it("creates a group with a normalized name and rejects duplicates and bad names", async () => {
			const res = await call(app, "/api/user-groups", { cookie: admin, body: { name: " Data-Team " } });
			expect(res.status).toBe(201);
			expect(((await res.json()) as { group: unknown }).group).toMatchObject({
				name: "data-team",
				source: "local",
				memberIds: [],
			});
			const dup = await call(app, "/api/user-groups", { cookie: admin, body: { name: "DATA-TEAM" } });
			expect(dup.status).toBe(400);
			expect((await call(app, "/api/user-groups", { cookie: admin, body: { name: "bad name" } })).status).toBe(400);
			expect((await call(app, "/api/user-groups", { cookie: admin, body: {} })).status).toBe(400);
			expect((await groups()).filter((g) => g.name === "data-team")).toHaveLength(1);
		});

		it("adds members idempotently, lists memberIds, removes members, deletes the group", async () => {
			const g = (await groups()).find((x) => x.name === "data-team");
			if (!g) throw new Error("group missing");
			const erin = await byName("erin");
			const hank = await byName("hank");
			const put = (uid: string) =>
				call(app, `/api/user-groups/${g.id}/members/${uid}`, { method: "PUT", cookie: admin, body: {} });
			const del = (uid: string) =>
				call(app, `/api/user-groups/${g.id}/members/${uid}`, { method: "DELETE", cookie: admin, body: {} });

			expect((await put(erin.id)).status).toBe(200);
			expect((await put(erin.id)).status).toBe(200);
			expect((await put(hank.id)).status).toBe(200);
			const listed = (await groups()).find((x) => x.id === g.id);
			expect([...(listed?.memberIds ?? [])].sort()).toEqual([erin.id, hank.id].sort());

			expect((await del(erin.id)).status).toBe(200);
			expect((await del(erin.id)).status).toBe(200); // removing a non-member is a no-op
			expect((await groups()).find((x) => x.id === g.id)?.memberIds).toEqual([hank.id]);

			expect((await call(app, `/api/user-groups/${g.id}`, { method: "DELETE", cookie: admin, body: {} })).status).toBe(
				200,
			);
			expect((await groups()).find((x) => x.id === g.id)).toBeUndefined();
			expect((await call(app, `/api/user-groups/${g.id}`, { method: "DELETE", cookie: admin, body: {} })).status).toBe(
				404,
			);
		});

		it("rejects adding a nonexistent user or to a nonexistent group", async () => {
			const created = await call(app, "/api/user-groups", { cookie: admin, body: { name: "ops" } });
			const g = ((await created.json()) as { group: { id: string } }).group;
			const bad = await call(app, `/api/user-groups/${g.id}/members/no-such-user`, {
				method: "PUT",
				cookie: admin,
				body: {},
			});
			expect(bad.status).toBe(404);
			expect(((await bad.json()) as { error: string }).error).toMatch(/no such user/);
			expect((await groups()).find((x) => x.id === g.id)?.memberIds).toEqual([]);
			const erin = await byName("erin");
			const badGroup = await call(app, `/api/user-groups/nope/members/${erin.id}`, {
				method: "PUT",
				cookie: admin,
				body: {},
			});
			expect(badGroup.status).toBe(404);
		});

		it("returns one group with its members and 404s when it is missing", async () => {
			const created = await call(app, "/api/user-groups", { cookie: admin, body: { name: "detail-ops" } });
			const g = ((await created.json()) as { group: { id: string } }).group;
			const erin = await byName("erin");
			const hank = await byName("hank");
			for (const user of [erin, hank]) {
				await call(app, `/api/user-groups/${g.id}/members/${user.id}`, { method: "PUT", cookie: admin, body: {} });
			}
			const res = await call(app, `/api/user-groups/${g.id}`, { cookie: admin });
			expect(res.status).toBe(200);
			expect(((await res.json()) as { group: UserGroupDetail }).group).toMatchObject({
				id: g.id,
				name: "detail-ops",
				createdAt: expect.any(String) as string,
				members: expect.arrayContaining([
					{ id: erin.id, username: "erin", displayName: "erin" },
					{ id: hank.id, username: "hank", displayName: "hank" },
				]),
			});
			expect((await call(app, "/api/user-groups/nope", { cookie: admin })).status).toBe(404);
			const erinCookie = await login(app, "erin", "erin-password");
			expect((await call(app, `/api/user-groups/${g.id}`, { cookie: erinCookie })).status).toBe(403);
		});

		it("renames a group with the creation rules and audits it", async () => {
			const created = await call(app, "/api/user-groups", { cookie: admin, body: { name: "rename-me" } });
			const g = ((await created.json()) as { group: { id: string } }).group;
			const other = await call(app, "/api/user-groups", { cookie: admin, body: { name: "taken-name" } });
			const otherId = ((await other.json()) as { group: { id: string } }).group.id;

			const renamed = await call(app, `/api/user-groups/${g.id}`, {
				method: "PATCH",
				cookie: admin,
				body: { name: " Renamed-Team " },
			});
			expect(renamed.status).toBe(200);
			expect(((await renamed.json()) as { group: { name: string } }).group.name).toBe("renamed-team");
			const listed = (await groups()).find((group) => group.id === g.id);
			expect(listed?.name).toBe("renamed-team");
			expect(
				(await call(app, `/api/user-groups/${g.id}`, { method: "PATCH", cookie: admin, body: { name: "taken-name" } }))
					.status,
			).toBe(400);
			expect(
				(await call(app, `/api/user-groups/${g.id}`, { method: "PATCH", cookie: admin, body: { name: "bad name" } }))
					.status,
			).toBe(400);
			expect((await call(app, `/api/user-groups/${g.id}`, { method: "PATCH", cookie: admin, body: {} })).status).toBe(
				400,
			);
			expect(
				(await call(app, "/api/user-groups/nope", { method: "PATCH", cookie: admin, body: { name: "x-team" } })).status,
			).toBe(404);
			const erinCookie = await login(app, "erin", "erin-password");
			expect(
				(await call(app, `/api/user-groups/${g.id}`, { method: "PATCH", cookie: erinCookie, body: { name: "x-team" } }))
					.status,
			).toBe(403);
			// The app under test has no audit route (no task runtime); read the recorded event directly.
			const events = await db
				.selectFrom("audit_events")
				.select(["target_id", "detail"])
				.where("action", "=", "user_group.renamed")
				.execute();
			expect(
				events.some(
					(event) => event.target_id === g.id && (JSON.parse(event.detail) as { name: string }).name === "renamed-team",
				),
			).toBe(true);
			expect(otherId).not.toBe(g.id);
		});

		it("an administrator cannot demote or disable themselves; another administrator does", async () => {
			await createUser(db, { username: "ivy", kind: "admin", password: "ivy-password" });
			const ivyCookie = await login(app, "ivy", "ivy-password");
			const ivy = await byName("ivy");
			const selfDemote = await call(app, `/api/users/${ivy.id}`, {
				method: "PATCH",
				cookie: ivyCookie,
				body: { kind: "member" },
			});
			expect(selfDemote.status).toBe(400);
			expect(((await selfDemote.json()) as { error: string }).error).toMatch(/another administrator/);
			const selfDisable = await call(app, `/api/users/${ivy.id}`, {
				method: "PATCH",
				cookie: ivyCookie,
				body: { status: "disabled" },
			});
			expect(selfDisable.status).toBe(400);
			expect(await byName("ivy")).toMatchObject({ kind: "admin", status: "active" });
			// Another administrator can do it.
			expect((await patch(ivy.id, { kind: "member" })).status).toBe(200);
			expect(await byName("ivy")).toMatchObject({ kind: "member" });
		});

		it("does not turn an unexpected TypeError into a 400", async () => {
			const real = db.selectFrom.bind(db);
			let trips = true;
			const selectFrom = vi.spyOn(db, "selectFrom").mockImplementation(((table: string) => {
				if (trips && table === "users") {
					trips = false;
					throw new TypeError("secret internal failure");
				}
				return (real as (found: string) => unknown)(table);
			}) as never);
			try {
				const res = await call(app, "/api/users", { cookie: admin });
				expect(res.status).toBe(500);
				expect(await res.text()).not.toContain("secret internal failure");
			} finally {
				selectFrom.mockRestore();
			}
			// Validation still answers 400 with its message.
			const bad = await patch((await byName("root")).id, { displayName: 5 });
			expect(bad.status).toBe(400);
			expect(((await bad.json()) as { error: string }).error).toContain("displayName must be a string");
		});

		it("members cannot touch groups", async () => {
			const erin = await login(app, "erin", "erin-password");
			expect((await call(app, "/api/user-groups", { cookie: erin, body: { name: "evil" } })).status).toBe(403);
			expect((await call(app, "/api/user-groups/x/members/y", { method: "PUT", cookie: erin, body: {} })).status).toBe(
				403,
			);
			expect((await call(app, "/api/users/x", { method: "PATCH", cookie: erin, body: { kind: "admin" } })).status).toBe(
				403,
			);
			expect(
				(await call(app, "/api/users/x/password", { cookie: erin, body: { password: "long-enough-1" } })).status,
			).toBe(403);
		});
	});
});

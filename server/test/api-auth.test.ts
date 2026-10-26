import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LoginLimiter } from "../src/auth/login-limiter.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp, sessionCookie } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

describeBackends("api auth", (backend) => {
	let db: Db;
	let app: App;
	let adminCookie: string;
	let memberCookie: string;

	beforeAll(async () => {
		db = await openTestDb(backend);
		app = makeApp(db);
		await createUser(db, { username: "root", kind: "admin", password: "root-password" });
		await createUser(db, { username: "alice", kind: "member", password: "alice-password" });
		await createUser(db, { username: "nopass", kind: "member" });
		adminCookie = await login(app, "root", "root-password");
		memberCookie = await login(app, "Alice", "alice-password"); // username is case-insensitive
	});
	afterAll(async () => {
		await db.destroy();
	});

	describe("login", () => {
		it("sets an HttpOnly SameSite=Strict cookie, without Secure on localhost", async () => {
			const res = await call(app, "/api/auth/login", { body: { username: "alice", password: "alice-password" } });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { user: Record<string, unknown> };
			expect(body.user.username).toBe("alice");
			expect(body.user).not.toHaveProperty("password_hash");
			expect(JSON.stringify(body)).not.toContain("scrypt");
			const setCookie = res.headers.get("set-cookie") ?? "";
			expect(setCookie).toMatch(/^crh_session=[A-Za-z0-9_-]{20,};/);
			expect(setCookie).toMatch(/HttpOnly/i);
			expect(setCookie).toMatch(/SameSite=Strict/i);
			expect(setCookie).toMatch(/Path=\//);
			expect(setCookie).toMatch(/Expires=/i);
			expect(setCookie).not.toMatch(/Secure/i);
		});

		it("sets Secure on a non-loopback host", async () => {
			const res = await call(app, "/api/auth/login", {
				body: { username: "alice", password: "alice-password" },
				headers: { host: "crh.example.com" },
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
		});

		it("rejects wrong password and unknown user with the same 401 message", async () => {
			const wrong = await call(app, "/api/auth/login", { body: { username: "alice", password: "nope-nope-nope" } });
			const unknown = await call(app, "/api/auth/login", { body: { username: "ghost", password: "whatever-pass" } });
			expect(wrong.status).toBe(401);
			expect(unknown.status).toBe(401);
			expect(await wrong.json()).toEqual(await unknown.json());
			expect(sessionCookie(wrong)).toBeUndefined();
		});

		it("rejects a user without a password", async () => {
			const res = await call(app, "/api/auth/login", { body: { username: "nopass", password: "anything-at-all" } });
			expect(res.status).toBe(401);
		});

		it("returns 400 for missing fields, wrong types and malformed bodies", async () => {
			for (const body of [{}, { username: "alice" }, { password: "x" }, { username: 1, password: "x" }, []]) {
				expect((await call(app, "/api/auth/login", { body })).status).toBe(400);
			}
			const bad = await app.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json", host: "localhost:8080" },
				body: "{not json",
			});
			expect(bad.status).toBe(400);
		});

		it("does not let a disabled user log in", async () => {
			await createUser(db, { username: "dis", kind: "member", password: "dis-password" });
			const patch = await call(app, "/api/users", { cookie: adminCookie });
			const id = ((await patch.json()) as { users: { id: string; username: string }[] }).users.find(
				(u) => u.username === "dis",
			)?.id;
			const res = await call(app, `/api/users/${id}`, {
				method: "PATCH",
				cookie: adminCookie,
				body: { status: "disabled" },
			});
			expect(res.status).toBe(200);
			const attempt = await call(app, "/api/auth/login", { body: { username: "dis", password: "dis-password" } });
			expect(attempt.status).toBe(401);
			expect(sessionCookie(attempt)).toBeUndefined();
		});
	});

	describe("rate limit", () => {
		it("blocks the 4th attempt after three failures, even with the right password", async () => {
			const limited = makeApp(db, new LoginLimiter(3, 60_000));
			for (let i = 0; i < 3; i++) {
				const res = await call(limited, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } });
				expect(res.status).toBe(401);
			}
			const res = await call(limited, "/api/auth/login", { body: { username: "alice", password: "alice-password" } });
			expect(res.status).toBe(429);
			expect(sessionCookie(res)).toBeUndefined();
			// The address key blocks other usernames from the same client too.
			const other = await call(limited, "/api/auth/login", { body: { username: "root", password: "root-password" } });
			expect(other.status).toBe(429);
		});

		it("a successful login resets the counters", async () => {
			const limited = makeApp(db, new LoginLimiter(3, 60_000));
			for (let i = 0; i < 2; i++) {
				await call(limited, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } });
			}
			expect(
				(await call(limited, "/api/auth/login", { body: { username: "alice", password: "alice-password" } })).status,
			).toBe(200);
			for (let i = 0; i < 2; i++) {
				expect(
					(await call(limited, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } })).status,
				).toBe(401);
			}
		});
	});

	describe("session", () => {
		it("/api/me is 401 without a cookie and with a garbage cookie", async () => {
			expect((await call(app, "/api/me")).status).toBe(401);
			expect((await call(app, "/api/me", { cookie: "crh_session=garbage" })).status).toBe(401);
			expect((await call(app, "/api/me", { cookie: "other=1" })).status).toBe(401);
		});

		it("/api/me returns the user with the cookie", async () => {
			const res = await call(app, "/api/me", { cookie: memberCookie });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { user: Record<string, unknown> };
			expect(body.user).toMatchObject({ username: "alice", kind: "member", status: "active" });
			expect(body.user).not.toHaveProperty("password_hash");
		});

		it("unknown /api routes require a session first", async () => {
			expect((await call(app, "/api/nope")).status).toBe(401);
			expect((await call(app, "/api/nope", { cookie: memberCookie })).status).toBe(404);
		});

		it("health is public", async () => {
			expect((await call(app, "/api/health")).status).toBe(200);
		});

		it("logout invalidates the session and clears the cookie", async () => {
			const cookie = await login(app, "alice", "alice-password");
			expect((await call(app, "/api/me", { cookie })).status).toBe(200);
			const out = await call(app, "/api/auth/logout", { method: "POST", cookie, body: {} });
			expect(out.status).toBe(200);
			expect(out.headers.get("set-cookie")).toMatch(/crh_session=;|Max-Age=0/);
			expect((await call(app, "/api/me", { cookie })).status).toBe(401);
			// other sessions are untouched
			expect((await call(app, "/api/me", { cookie: memberCookie })).status).toBe(200);
		});

		it("logout without a session is 401", async () => {
			expect((await call(app, "/api/auth/logout", { method: "POST", body: {} })).status).toBe(401);
		});

		it("an expired session is rejected", async () => {
			const cookie = await login(app, "alice", "alice-password");
			await db
				.updateTable("web_sessions")
				.set({ expires_at: new Date(Date.now() - 1000).toISOString() })
				.execute();
			expect((await call(app, "/api/me", { cookie })).status).toBe(401);
			// restore a usable member/admin session for later tests
			memberCookie = await login(app, "alice", "alice-password");
			adminCookie = await login(app, "root", "root-password");
		});
	});

	describe("csrf guard", () => {
		it("rejects non-JSON content types on state-changing requests", async () => {
			for (const contentType of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
				const headers: Record<string, string> = { host: "localhost:8080" };
				if (contentType) headers["content-type"] = contentType;
				const res = await app.request("/api/auth/login", {
					method: "POST",
					headers,
					body: contentType ? '{"username":"a","password":"b"}' : undefined,
				});
				expect(res.status).toBe(400);
			}
		});

		it("accepts content-type with a charset parameter", async () => {
			const res = await call(app, "/api/auth/login", {
				body: { username: "ghost", password: "x" },
				headers: { "content-type": "application/json; charset=utf-8" },
			});
			expect(res.status).toBe(401);
		});

		it("rejects a cross-origin Origin with 403, even with a valid session", async () => {
			const res = await call(app, "/api/auth/logout", {
				method: "POST",
				cookie: memberCookie,
				body: {},
				headers: { origin: "https://evil.example" },
			});
			expect(res.status).toBe(403);
			expect((await call(app, "/api/me", { cookie: memberCookie })).status).toBe(200);
		});

		it("rejects an unparsable Origin", async () => {
			const res = await call(app, "/api/auth/login", {
				body: { username: "a", password: "b" },
				headers: { origin: "not a url" },
			});
			expect(res.status).toBe(403);
		});

		it("lets a matching Origin through", async () => {
			const res = await call(app, "/api/auth/login", {
				body: { username: "ghost", password: "x" },
				headers: { origin: "http://localhost:8080" },
			});
			expect(res.status).toBe(401); // got past the guard
		});

		it("does not apply to GET", async () => {
			const res = await call(app, "/api/me", { cookie: memberCookie, headers: { origin: "https://evil.example" } });
			expect(res.status).toBe(200);
		});
	});

	describe("admin only", () => {
		it("member gets 403, admin succeeds", async () => {
			expect((await call(app, "/api/users", { cookie: memberCookie })).status).toBe(403);
			expect(
				(await call(app, "/api/users", { cookie: memberCookie, body: { username: "x1", password: "password-1" } }))
					.status,
			).toBe(403);
			expect((await call(app, "/api/user-groups", { cookie: memberCookie })).status).toBe(403);
			expect((await call(app, "/api/users", { cookie: adminCookie })).status).toBe(200);
			expect((await call(app, "/api/user-groups", { cookie: adminCookie })).status).toBe(200);
		});

		it("anonymous gets 401", async () => {
			expect((await call(app, "/api/users")).status).toBe(401);
			expect((await call(app, "/api/user-groups")).status).toBe(401);
		});
	});

	describe("own password change", () => {
		it("wrong current password is 403, short new password 400, missing fields 400", async () => {
			const cookie = await login(app, "root", "root-password");
			const wrong = await call(app, "/api/auth/password", {
				cookie,
				body: { currentPassword: "bad-bad-bad", newPassword: "new-password-1" },
			});
			expect(wrong.status).toBe(403);
			const short = await call(app, "/api/auth/password", {
				cookie,
				body: { currentPassword: "root-password", newPassword: "short" },
			});
			expect(short.status).toBe(400);
			expect((await call(app, "/api/auth/password", { cookie, body: { newPassword: "new-password-1" } })).status).toBe(
				400,
			);
			expect((await call(app, "/api/auth/password", { body: { currentPassword: "a", newPassword: "b" } })).status).toBe(
				401,
			);
			// password unchanged
			expect(
				(await call(app, "/api/auth/login", { body: { username: "root", password: "root-password" } })).status,
			).toBe(200);
		});

		it("success keeps this session, revokes the others, and swaps the password", async () => {
			await createUser(db, { username: "bob", kind: "member", password: "bob-password-1" });
			const a = await login(app, "bob", "bob-password-1");
			const b = await login(app, "bob", "bob-password-1");
			const res = await call(app, "/api/auth/password", {
				cookie: a,
				body: { currentPassword: "bob-password-1", newPassword: "bob-password-2" },
			});
			expect(res.status).toBe(200);
			expect((await call(app, "/api/me", { cookie: a })).status).toBe(200);
			expect((await call(app, "/api/me", { cookie: b })).status).toBe(401);
			expect(
				(await call(app, "/api/auth/login", { body: { username: "bob", password: "bob-password-1" } })).status,
			).toBe(401);
			expect(
				(await call(app, "/api/auth/login", { body: { username: "bob", password: "bob-password-2" } })).status,
			).toBe(200);
		});
	});
});

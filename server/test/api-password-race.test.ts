import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { hashPassword, needsRehash, setArgon2ParametersForTesting, verifyPassword } from "../src/auth/password.ts";
import { createWebSessionIfCredentialCurrent } from "../src/auth/sessions.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser, findUserByUsername } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

// The login route imports verifyPassword directly, so a module wrapper is the only way to hold a
// successful verification after it returned and before the route issues the session.
const control = vi.hoisted(() => {
	const state = {
		armed: false,
		entered: Promise.resolve(),
		released: Promise.resolve(),
		enter: () => {},
		release: () => {},
		reset: () => {},
	};
	state.reset = () => {
		state.entered = new Promise<void>((resolve) => {
			state.enter = resolve;
		});
		state.released = new Promise<void>((resolve) => {
			state.release = resolve;
		});
	};
	state.reset();
	return state;
});

vi.mock("../src/auth/password.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/auth/password.ts")>();
	return {
		...actual,
		verifyPassword: async (...args: Parameters<typeof actual.verifyPassword>) => {
			const ok = await actual.verifyPassword(...args);
			if (ok && control.armed) {
				control.armed = false;
				control.enter();
				await control.released;
			}
			return ok;
		},
	};
});

describeBackends("password reset versus an in-flight login", (backend) => {
	let db: Db;
	let app: App;
	let adminCookie: string;

	beforeAll(async () => {
		db = await openTestDb(backend);
		app = makeApp(db);
		await createUser(db, { username: "root", kind: "admin", password: "root-password" });
		adminCookie = await login(app, "root", "root-password");
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("does not issue a session after the reset commits first", async () => {
		const user = await createUser(db, { username: "race-session", kind: "member", password: "old-password" });
		control.reset();
		control.armed = true;
		const pending = call(app, "/api/auth/login", { body: { username: "race-session", password: "old-password" } });
		await control.entered;

		const reset = await call(app, `/api/users/${user.id}/password`, {
			method: "POST",
			cookie: adminCookie,
			body: { password: "new-password" },
		});
		expect(reset.status).toBe(200);
		control.release();

		const loginResponse = await pending;
		expect(loginResponse.status).toBe(401);
		expect(loginResponse.headers.get("set-cookie")).toBeNull();
		const sessions = await db.selectFrom("web_sessions").select("id").where("user_id", "=", user.id).execute();
		expect(sessions).toEqual([]);

		const current = await findUserByUsername(db, "race-session");
		expect(await verifyPassword("new-password", current?.password_hash ?? "")).toBe(true);
		expect(await verifyPassword("old-password", current?.password_hash ?? "")).toBe(false);
	});

	it("does not write the old hash back after the reset commits first", async () => {
		// Create the hash at older parameters so the login needs a rehash, then restore the test parameters.
		setArgon2ParametersForTesting({ memory: 512, passes: 1, parallelism: 1 });
		const user = await createUser(db, { username: "race-rehash", kind: "member", password: "old-password" });
		setArgon2ParametersForTesting({ memory: 1024, passes: 1, parallelism: 1 });
		const before = await findUserByUsername(db, "race-rehash");
		expect(needsRehash(before?.password_hash ?? "")).toBe(true);

		control.reset();
		control.armed = true;
		const pending = call(app, "/api/auth/login", { body: { username: "race-rehash", password: "old-password" } });
		await control.entered;

		const reset = await call(app, `/api/users/${user.id}/password`, {
			method: "POST",
			cookie: adminCookie,
			body: { password: "new-password" },
		});
		expect(reset.status).toBe(200);
		control.release();

		const loginResponse = await pending;
		expect(loginResponse.status).toBe(401);
		const current = await findUserByUsername(db, "race-rehash");
		expect(await verifyPassword("new-password", current?.password_hash ?? "")).toBe(true);
		expect(await verifyPassword("old-password", current?.password_hash ?? "")).toBe(false);
	});

	if (backend === "postgres") {
		it("waits for a reset transaction before issuing a session for the old credential", async () => {
			const user = await createUser(db, { username: "race-lock", kind: "member", password: "old-password" });
			const before = await findUserByUsername(db, "race-lock");
			const oldHash = before?.password_hash;
			if (!oldHash) throw new Error("no password hash");
			const newHash = await hashPassword("new-password");

			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started!: () => void;
			const resetStarted = new Promise<void>((resolve) => {
				started = resolve;
			});
			const reset = db.transaction().execute(async (trx) => {
				await trx.updateTable("users").set({ password_hash: newHash }).where("id", "=", user.id).execute();
				await trx.deleteFrom("web_sessions").where("user_id", "=", user.id).execute();
				started();
				await gate;
			});
			await resetStarted;

			let settled = false;
			const login = createWebSessionIfCredentialCurrent(db, user.id, oldHash, { ip: null, userAgent: null });
			void login.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await new Promise((resolve) => setTimeout(resolve, 100));
				expect(settled).toBe(false);
			} finally {
				release();
				await reset;
			}

			expect(await login).toBeUndefined();
			expect(await db.selectFrom("web_sessions").select("id").where("user_id", "=", user.id).execute()).toEqual([]);
		});
	}
});

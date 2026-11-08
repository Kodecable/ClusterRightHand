import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HashBusyError } from "../src/auth/hash-gate.ts";
import { LoginLimiter } from "../src/auth/login-limiter.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, login, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The route imports verifyPassword directly, so a module mock is the only way to hold one password
// change inside the verify step and to make a wrong/right answer deterministic.
const control = vi.hoisted(() => {
	const state = {
		entered: Promise.resolve(),
		released: Promise.resolve(),
		enteredNow: () => {},
		release: () => {},
		result: false,
		fast: false,
		throwNext: false,
		calls: 0,
		reset: () => {},
	};
	state.reset = () => {
		state.entered = new Promise<void>((resolve) => {
			state.enteredNow = resolve;
		});
		state.released = new Promise<void>((resolve) => {
			state.release = resolve;
		});
		state.result = false;
		state.fast = false;
		state.throwNext = false;
		state.calls = 0;
	};
	state.reset();
	return state;
});

vi.mock("../src/auth/password.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/auth/password.ts")>();
	return {
		...actual,
		verifyPassword: async () => {
			control.calls++;
			if (control.throwNext) {
				control.throwNext = false;
				throw new HashBusyError();
			}
			if (control.fast) return control.result;
			control.enteredNow();
			await control.released;
			return control.result;
		},
	};
});

const PASSWORD = "password-123";

describe("POST /password is rate limited", () => {
	let db: Db;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
	});
	afterAll(async () => {
		await db.destroy();
	});

	/** A logged-in app for one user; every test gets its own limiter so counts never leak. */
	async function loggedIn(
		username: string,
		limiter = new LoginLimiter(10, 60_000),
	): Promise<{ app: App; cookie: string }> {
		await createUser(db, { username, kind: "member", password: PASSWORD });
		const app = makeApp(db, limiter);
		// Login must pass through the mocked verify too; a correct answer is enough.
		control.fast = true;
		control.result = true;
		const cookie = await login(app, username, PASSWORD);
		return { app, cookie };
	}

	it("reserves a wrong current password and answers 429 like a limited login", async () => {
		const limiter = new LoginLimiter(2, 60_000);
		const { app, cookie } = await loggedIn("pw-limit", limiter);
		control.fast = true;
		control.result = false;
		const change = (password: string) =>
			call(app, "/api/auth/password", {
				cookie,
				body: { currentPassword: password, newPassword: "new-password-1" },
			});
		expect((await change("wrong-1")).status).toBe(403);
		expect((await change("wrong-2")).status).toBe(403);
		const limited = await change("wrong-3");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({
			error: "too many failed attempts, try again later",
			code: "rate_limited",
		});
	});

	it("clears the account key and refunds the address reservation on success", async () => {
		const limiter = new LoginLimiter(2, 60_000);
		const { app, cookie } = await loggedIn("pw-clear", limiter);
		const change = (password: string, next: string) =>
			call(app, "/api/auth/password", { cookie, body: { currentPassword: password, newPassword: next } });
		control.fast = true;
		control.result = false;
		expect((await change("wrong", "new-password-1")).status).toBe(403);
		// The right password is not a failure; the reservation for this request is given back too.
		control.result = true;
		expect((await change(PASSWORD, "new-password-2")).status).toBe(200);
		control.result = false;
		// One failure is allowed again: a leftover count plus this one would have been a 429.
		expect((await change("wrong", "new-password-3")).status).toBe(403);
	});

	it("rejects a second concurrent change for the same account with 429", async () => {
		const { app, cookie } = await loggedIn("pw-concurrent");
		control.reset();
		const first = call(app, "/api/auth/password", {
			cookie,
			body: { currentPassword: "wrong", newPassword: "new-password-1" },
		});
		await control.entered;
		const second = await call(app, "/api/auth/password", {
			cookie,
			body: { currentPassword: "wrong", newPassword: "new-password-2" },
		});
		expect(second.status).toBe(429);
		expect(await second.json()).toMatchObject({ code: "password_change_in_progress" });
		control.release();
		expect((await first).status).toBe(403);

		// The in-flight slot was released: the next request reaches the verify step again.
		control.reset();
		control.fast = true;
		control.result = false;
		expect(
			(
				await call(app, "/api/auth/password", {
					cookie,
					body: { currentPassword: "wrong", newPassword: "new-password-1" },
				})
			).status,
		).toBe(403);
	});

	it("does not count a busy hash gate as a failed attempt", async () => {
		const limiter = new LoginLimiter(1, 60_000);
		const { app, cookie } = await loggedIn("pw-busy", limiter);
		control.reset();
		control.throwNext = true;
		const busy = await call(app, "/api/auth/password", {
			cookie,
			body: { currentPassword: "wrong", newPassword: "new-password-1" },
		});
		expect(busy.status).toBe(503);
		expect(busy.headers.get("retry-after")).toBe("1");
		// The reservation was refunded, so this reaches the password check instead of a 429.
		control.fast = true;
		control.result = false;
		expect(
			(
				await call(app, "/api/auth/password", {
					cookie,
					body: { currentPassword: "wrong", newPassword: "new-password-1" },
				})
			).status,
		).toBe(403);
	});
});

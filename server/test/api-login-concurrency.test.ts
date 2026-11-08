import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.ts";
import { Audit } from "../src/audit/audit.ts";
import { HashBusyError } from "../src/auth/hash-gate.ts";
import { LoginLimiter } from "../src/auth/login-limiter.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import { type App, call, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

// The route imports verifyPassword directly, so the only way to hold one login inside the verify step is a
// module mock. Everything else in password.ts stays real (hashPassword is needed for the test users).
const control = vi.hoisted(() => {
	const state = {
		entered: Promise.resolve(),
		released: Promise.resolve(),
		enteredNow: () => {},
		release: () => {},
		throwNext: false,
		fast: false,
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
		state.throwNext = false;
		state.fast = false;
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
			if (control.fast) return false;
			control.enteredNow();
			await control.released;
			return false;
		},
	};
});

describe("login in-flight limit", () => {
	let db: Db;
	let app: App;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		await createUser(db, { username: "alice", kind: "member", password: "alice-password" });
		app = makeApp(db, new LoginLimiter(20, 60_000));
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("answers 429 login_in_progress for a second login from the same address", async () => {
		control.reset();
		const first = call(app, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } });
		await control.entered;
		const second = await call(app, "/api/auth/login", { body: { username: "bob", password: "wrong-wrong" } });
		expect(second.status).toBe(429);
		expect(await second.json()).toMatchObject({
			error: "a login from this address is already in progress",
			code: "login_in_progress",
		});
		control.release();
		expect((await first).status).toBe(401);

		// The slot was released in finally: this one reaches the verify step again.
		control.reset();
		const third = call(app, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } });
		await control.entered;
		control.release();
		expect((await third).status).toBe(401);
	});

	it("releases the in-flight slot when verification throws and maps HashBusyError to 503", async () => {
		control.reset();
		control.throwNext = true;
		const busy = await call(app, "/api/auth/login", { body: { username: "alice", password: "alice-password" } });
		expect(busy.status).toBe(503);
		expect(busy.headers.get("retry-after")).toBe("1");
		expect(await busy.json()).toEqual({ error: "the server is busy, try again", code: "hash_busy" });

		const next = call(app, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } });
		await control.entered;
		control.release();
		expect((await next).status).toBe(401);
	});

	it("lets only the failure limit reach hashing when no address is known", async () => {
		control.reset();
		control.fast = true;
		// No clientAddress: only the addr-user key exists, so there is no per-address in-flight limit.
		const limiter = new LoginLimiter(10, 60_000);
		const audit = new Audit(db);
		const bare = createApp(db, { limiter, captcha: "none", audit });
		const attempts = Array.from({ length: 20 }, () =>
			call(bare, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } }),
		);
		const results = await Promise.all(attempts);
		await audit.flush();
		expect(control.calls).toBe(10);
		expect(results.filter((res) => res.status === 401)).toHaveLength(10);
		expect(results.filter((res) => res.status === 429)).toHaveLength(10);
	});
	it("does not count an in-flight rejection or a busy hash queue as a failure", async () => {
		// Two allowed failures per key: a stray count from either rejection would turn the last 401 into a 429.
		const tight = makeApp(db, new LoginLimiter(2, 60_000));

		control.reset();
		control.throwNext = true;
		expect(
			(await call(tight, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } })).status,
		).toBe(503);

		control.reset();
		const first = call(tight, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } });
		await control.entered;
		const second = await call(tight, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } });
		expect(second.status).toBe(429);
		control.release();
		expect((await first).status).toBe(401);

		control.reset();
		control.fast = true;
		expect(
			(await call(tight, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } })).status,
		).toBe(401);
		expect(
			(await call(tight, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong" } })).status,
		).toBe(429);
	});
});

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueLoginChallenge, loginTag } from "../src/auth/captcha.ts";
import { LoginLimiter, loginAttemptKeys } from "../src/auth/login-limiter.ts";
import type { Db } from "../src/storage/db.ts";
import { createUser } from "../src/users/service.ts";
import type { App } from "./helpers/api.ts";
import { call, makeApp } from "./helpers/api.ts";
import { openTestDb } from "./helpers/db.ts";

/** Low difficulty so the test solver is fast; the route's production defaults are the constants in captcha.ts. */
const LOW = { challengeCount: 2, challengeSize: 8, challengeDifficulty: 1 };
const ADDRESS = "198.51.100.7";

// The solver is capjs-core's algorithm, reimplemented here because the package does not export it: the
// challenge salt and target come from an FNV-1a walk over the token and the challenge index.
function fnv1a(input: string): number {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	return hash >>> 0;
}

function fnv1aResume(state: number, input: string): number {
	let hash = state;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	return hash >>> 0;
}

function prngFromHash(initial: number, length: number): string {
	let state = initial;
	let result = "";
	while (result.length < length) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		result += state.toString(16).padStart(8, "0");
	}
	return result.substring(0, length);
}

function solve(token: string, challenge: { c: number; s: number; d: number }): number[] {
	const tokenHash = fnv1a(token);
	const solutions: number[] = [];
	for (let index = 0; index < challenge.c; index++) {
		const saltSeed = fnv1aResume(tokenHash, String(index + 1));
		const target = prngFromHash(fnv1aResume(saltSeed, "d"), challenge.d);
		const salt = prngFromHash(saltSeed, challenge.s);
		let nonce = 0;
		for (;;) {
			if (
				createHash("sha256")
					.update(salt + String(nonce))
					.digest("hex")
					.startsWith(target)
			) {
				solutions.push(nonce);
				break;
			}
			nonce++;
		}
	}
	return solutions;
}

function capApp(db: Db, limiter: LoginLimiter = new LoginLimiter()): App {
	return makeApp(db, limiter, { captcha: "cap", captchaChallenge: LOW });
}

async function challengeFor(app: App, username: string, tag: string) {
	const res = await call(app, "/api/auth/login/challenge", { body: { username, tag } });
	expect(res.status).toBe(200);
	return (await res.json()) as { challenge: { c: number; s: number; d: number }; token: string; expires: number };
}

describe("captcha login", () => {
	let db: Db;

	beforeAll(async () => {
		db = await openTestDb("sqlite");
		await createUser(db, { username: "alice", kind: "member", password: "alice-password" });
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("advertises the mode on login-options", async () => {
		const none = await call(makeApp(db), "/api/auth/login-options");
		expect(await none.json()).toEqual({ captcha: "none" });
		const cap = await call(capApp(db), "/api/auth/login-options");
		expect(await cap.json()).toEqual({ captcha: "cap" });
	});

	it("returns 404 from the challenge route when captcha is off", async () => {
		const res = await call(makeApp(db), "/api/auth/login/challenge", {
			body: { username: "alice", tag: loginTag("alice", "alice-password") },
		});
		expect(res.status).toBe(404);
	});

	it("validates the challenge body and blocks a limited address", async () => {
		const app = capApp(db);
		for (const body of [{}, { username: "alice" }, { username: "alice", tag: "short" }, { username: 1, tag: "x" }]) {
			expect((await call(app, "/api/auth/login/challenge", { body })).status).toBe(400);
		}

		const limiter = new LoginLimiter(1, 60_000);
		limiter.reserve(loginAttemptKeys(ADDRESS, "alice").all);
		const blocked = capApp(db, limiter);
		const res = await call(blocked, "/api/auth/login/challenge", {
			body: { username: "alice", tag: loginTag("alice", "alice-password") },
		});
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ code: "rate_limited" });
	});

	it("issues a low-difficulty challenge with exactly the public fields", async () => {
		const app = capApp(db);
		const before = Date.now();
		const body = await challengeFor(app, "alice", loginTag("alice", "alice-password"));
		expect(Object.keys(body).sort()).toEqual(["challenge", "expires", "token"]);
		expect(body.challenge).toEqual({ c: LOW.challengeCount, s: LOW.challengeSize, d: LOW.challengeDifficulty });
		expect(body.expires).toBeGreaterThanOrEqual(before + 119_000);
		expect(body.expires).toBeLessThanOrEqual(Date.now() + 120_000);
		expect(body.token.split(".").length).toBe(3);
	});

	it("logs in when the proof of work is valid", async () => {
		const app = capApp(db);
		const { challenge, token } = await challengeFor(app, "alice", loginTag("alice", "alice-password"));
		const res = await call(app, "/api/auth/login", {
			body: {
				username: "alice",
				password: "alice-password",
				cap: { token, solutions: solve(token, challenge) },
			},
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toMatch(/crh_session=/);
	});

	it("requires a cap object when captcha is on", async () => {
		const app = capApp(db);
		const res = await call(app, "/api/auth/login", { body: { username: "alice", password: "alice-password" } });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "captcha_required" });

		const bad = await call(app, "/api/auth/login", {
			body: { username: "alice", password: "alice-password", cap: "nope" },
		});
		expect(bad.status).toBe(403);
		expect(await bad.json()).toMatchObject({ code: "captcha_failed", reason: "missing_token" });
	});

	it("rejects a challenge solved for another password with a scope mismatch", async () => {
		const app = capApp(db);
		const { challenge, token } = await challengeFor(app, "alice", loginTag("alice", "wrong-password"));
		const res = await call(app, "/api/auth/login", {
			body: {
				username: "alice",
				password: "alice-password",
				cap: { token, solutions: solve(token, challenge) },
			},
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "captcha_failed", reason: "scope_mismatch" });
	});

	it("rejects a challenge issued for another address", async () => {
		const app = capApp(db);
		const tag = loginTag("alice", "alice-password");
		const { challenge, token } = await issueLoginChallenge({
			address: "198.51.100.99",
			username: "alice",
			tag,
			parameters: LOW,
		});
		const res = await call(app, "/api/auth/login", {
			body: {
				username: "alice",
				password: "alice-password",
				cap: { token, solutions: solve(token, challenge) },
			},
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "captcha_failed", reason: "scope_mismatch" });
	});

	it("rejects an expired challenge", async () => {
		const app = capApp(db);
		const tag = loginTag("alice", "alice-password");
		const { challenge, token } = await issueLoginChallenge({
			address: ADDRESS,
			username: "alice",
			tag,
			ttlMs: -1_000,
			parameters: LOW,
		});
		const res = await call(app, "/api/auth/login", {
			body: {
				username: "alice",
				password: "alice-password",
				cap: { token, solutions: solve(token, challenge) },
			},
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "captcha_failed", reason: "expired" });
	});

	it("accepts a replayed valid token for the same guess, and each failure counts", async () => {
		const limiter = new LoginLimiter(3, 60_000);
		const app = capApp(db, limiter);
		const { challenge, token } = await challengeFor(app, "alice", loginTag("alice", "wrong-wrong"));
		const cap = { token, solutions: solve(token, challenge) };
		for (let i = 0; i < 3; i++) {
			const res = await call(app, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong", cap } });
			// The PoW is valid and replayable; the password is what fails, and the attempt is counted.
			expect(res.status).toBe(401);
		}
		const blocked = await call(app, "/api/auth/login", { body: { username: "alice", password: "wrong-wrong", cap } });
		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toMatchObject({ code: "rate_limited" });
	});

	it("ignores the cap field when captcha is off", async () => {
		const app = makeApp(db);
		const res = await call(app, "/api/auth/login", {
			body: { username: "alice", password: "alice-password", cap: { token: "garbage", solutions: [1, 2] } },
		});
		expect(res.status).toBe(200);
	});
});

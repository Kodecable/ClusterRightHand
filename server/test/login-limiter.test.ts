import { describe, expect, it } from "vitest";
import { LoginLimiter, loginAttemptKeys, MAX_LOGIN_FAILURES } from "../src/auth/login-limiter.ts";

describe("loginAttemptKeys", () => {
	it("uses the address key and the lowercased trimmed address+user key", () => {
		const keys = loginAttemptKeys("203.0.113.9", " Alice ");
		expect(keys.addressKey).toBe("addr:203.0.113.9");
		expect(keys.userKey).toBe("addr-user:203.0.113.9\0alice");
		expect(keys.all).toEqual([keys.userKey, keys.addressKey]);
	});

	it("uses an empty address when none is known", () => {
		const keys = loginAttemptKeys(undefined, "Alice");
		expect(keys.addressKey).toBeUndefined();
		expect(keys.userKey).toBe("addr-user:\0alice");
		expect(keys.all).toEqual([keys.userKey]);
	});
});

describe("LoginLimiter", () => {
	it("reserves at most maxFailures attempts in one synchronous burst", () => {
		const limiter = new LoginLimiter(10, 60_000);
		const keys = loginAttemptKeys("198.51.100.9", "alice").all;
		let accepted = 0;
		for (let i = 0; i < 20; i++) if (limiter.reserve(keys)) accepted++;
		expect(accepted).toBe(10);
		expect(limiter.isBlocked(keys)).toBe(true);
	});

	it("a successful login clears only addr-user and gives back its own address reservation", () => {
		const limiter = new LoginLimiter(3, 60_000);
		const alice = loginAttemptKeys("198.51.100.9", "Alice");
		const bob = loginAttemptKeys("198.51.100.9", "bob");
		expect(limiter.reserve(alice.all)).toBe(true);
		expect(limiter.reserve(alice.all)).toBe(true);
		expect(limiter.reserve(bob.all)).toBe(true);
		// The address is at the limit already; alice's success undoes only her own reservation.
		limiter.clearUser(alice.userKey);
		limiter.refund(alice.addressKey as string);
		expect(limiter.isBlocked([alice.userKey])).toBe(false);
		expect(limiter.isBlocked([bob.userKey])).toBe(false);
		expect(limiter.isBlocked([alice.addressKey as string])).toBe(false);
		// bob's next failure reaches the address limit; if success had reset the address this would not be blocked.
		expect(limiter.reserve(bob.all)).toBe(true);
		expect(limiter.isBlocked([alice.addressKey as string])).toBe(true);
		expect(limiter.reserve(loginAttemptKeys("198.51.100.9", "carol").all)).toBe(false);
	});

	it("allows one in-flight verify per address and releases it explicitly", () => {
		const limiter = new LoginLimiter();
		expect(limiter.beginVerify("198.51.100.9")).toBe(true);
		expect(limiter.beginVerify("198.51.100.9")).toBe(false);
		expect(limiter.beginVerify("198.51.100.10")).toBe(true);
		limiter.endVerify("198.51.100.9");
		expect(limiter.beginVerify("198.51.100.9")).toBe(true);
	});

	it("forgets entries after their window", () => {
		const limiter = new LoginLimiter(1, 1_000);
		const keys = loginAttemptKeys("198.51.100.9", "alice").all;
		expect(limiter.reserve(keys, 0)).toBe(true);
		expect(limiter.isBlocked(keys, 500)).toBe(true);
		expect(limiter.isBlocked(keys, 1_001)).toBe(false);
		expect(limiter.reserve(keys, 1_001)).toBe(true);
	});

	it("evicts the oldest failure entry at the cap", () => {
		const limiter = new LoginLimiter(1, 60_000, 2);
		const first = loginAttemptKeys(undefined, "first");
		const second = loginAttemptKeys(undefined, "second");
		const third = loginAttemptKeys(undefined, "third");
		for (const keys of [first, second, third]) limiter.recordFailure(keys.all, 1_000);
		expect(limiter.size).toBe(2);
		// The entry inserted first is gone; the two later keys are still limited.
		expect(limiter.isBlocked(first.all, 1_000)).toBe(false);
		expect(limiter.isBlocked(second.all, 1_000)).toBe(true);
		expect(limiter.isBlocked(third.all, 1_000)).toBe(true);
	});

	it("bounds the failure map with rotating keys and still limits one repeated key", () => {
		const limiter = new LoginLimiter(3, 60_000);
		// An unauthenticated attacker controls the username: many distinct keys must not grow the map.
		for (let index = 0; index < MAX_LOGIN_FAILURES + 500; index++) {
			limiter.recordFailure(loginAttemptKeys(undefined, `rotated-${index}`).all, 1_000);
		}
		expect(limiter.size).toBe(MAX_LOGIN_FAILURES);
		expect(limiter.isBlocked(loginAttemptKeys(undefined, "rotated-0").all, 1_000)).toBe(false);

		// A real brute-force on one address+username still reaches the limit.
		const keys = loginAttemptKeys("198.51.100.7", "alice");
		expect(limiter.reserve(keys.all, 1_000)).toBe(true);
		expect(limiter.reserve(keys.all, 1_000)).toBe(true);
		expect(limiter.reserve(keys.all, 1_000)).toBe(true);
		expect(limiter.isBlocked(keys.all, 1_000)).toBe(true);
		expect(limiter.reserve(keys.all, 1_000)).toBe(false);
		expect(limiter.size).toBeLessThanOrEqual(MAX_LOGIN_FAILURES);
	});
});

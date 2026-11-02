import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_HASH_PARAMETERS,
	hashPassword,
	needsRehash,
	setHashParametersForTesting,
	verifyPassword,
} from "../src/auth/password.ts";

// The production scrypt cost makes one hash take hundreds of milliseconds; a loaded machine can push
// the default 5 s timeout over.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("password hashing", () => {
	// vitest.setup.ts lowers the cost for other suites; this one checks the production parameters.
	beforeAll(() => setHashParametersForTesting(DEFAULT_HASH_PARAMETERS));

	it("round-trips and rejects wrong passwords", async () => {
		const encoded = await hashPassword("correct horse");
		expect(encoded).toMatch(/^scrypt\$131072\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
		expect(await verifyPassword("correct horse", encoded)).toBe(true);
		expect(await verifyPassword("wrong horse", encoded)).toBe(false);
		expect(await verifyPassword("", encoded)).toBe(false);
		expect(needsRehash(encoded)).toBe(false);
	});

	it("uses a fresh salt each time", async () => {
		const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
		expect(a).not.toBe(b);
	});

	it("normalizes with NFKC", async () => {
		const encoded = await hashPassword("ｐａｓｓ");
		expect(await verifyPassword("pass", encoded)).toBe(true);
		const composed = await hashPassword("café");
		expect(await verifyPassword("café", composed)).toBe(true);
	});

	it("limits password length", async () => {
		await expect(hashPassword("a".repeat(1025))).rejects.toThrow(RangeError);
		const encoded = await hashPassword("a".repeat(1024));
		expect(await verifyPassword("a".repeat(1024), encoded)).toBe(true);
		expect(await verifyPassword("a".repeat(1025), encoded)).toBe(false);
	});

	it("returns false for malformed encodings", async () => {
		const bad = [
			"",
			"garbage",
			"scrypt$131072$8$1$abc",
			"bcrypt$131072$8$1$AAAA$AAAA",
			"scrypt$x$8$1$AAAA$AAAA",
			"scrypt$131072$8$1$$",
			"scrypt$131072$8$1$AAAA$AAAA",
			"scrypt$131072$8$1$AA AA$AAAA",
		];
		for (const encoded of bad) {
			expect(await verifyPassword("pw", encoded)).toBe(false);
			expect(needsRehash(encoded)).toBe(true);
		}
	});

	it("rejects tampered or absurd parameters", async () => {
		const encoded = await hashPassword("pw");
		const [, , , , salt, hash] = encoded.split("$");
		const variants = [
			`scrypt$131073$8$1$${salt}$${hash}`,
			`scrypt$${2 ** 21}$8$1$${salt}$${hash}`,
			`scrypt$131072$33$1$${salt}$${hash}`,
			`scrypt$131072$8$17$${salt}$${hash}`,
			`scrypt$131072$8$0$${salt}$${hash}`,
			`scrypt$131072$8$1$${salt}$${hash?.slice(0, -4)}`,
		];
		for (const v of variants) expect(await verifyPassword("pw", v)).toBe(false);
		// Valid format but different parameters: hash no longer matches.
		expect(await verifyPassword("pw", `scrypt$16384$8$1$${salt}$${hash}`)).toBe(false);
	});

	it("keeps old parameter sets working and flags them for rehash", async () => {
		const { scryptSync } = await import("node:crypto");
		const salt = Buffer.alloc(16, 7);
		const key = scryptSync("old pw", salt, 32, { N: 16384, r: 8, p: 1 });
		const encoded = `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
		expect(await verifyPassword("old pw", encoded)).toBe(true);
		expect(await verifyPassword("new pw", encoded)).toBe(false);
		expect(needsRehash(encoded)).toBe(true);
	});
});

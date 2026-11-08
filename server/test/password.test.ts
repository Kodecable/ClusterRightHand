import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HashBusyError, resetHashGateForTesting, withHashSlot } from "../src/auth/hash-gate.ts";
import {
	DEFAULT_ARGON2_PARAMETERS,
	hashPassword,
	needsRehash,
	setArgon2ParametersForTesting,
	verifyPassword,
} from "../src/auth/password.ts";

// Argon2id is memory-hard even at the test cost; a loaded machine can push the default 5 s timeout over.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TEST_PARAMETERS = { memory: 2048, passes: 1, parallelism: 1 };

function base64(buffer: Buffer): string {
	return buffer.toString("base64").replace(/=+$/, "");
}

describe("password hashing", () => {
	// vitest.setup.ts lowers the cost for other suites; this suite uses a slightly larger one, and one test
	// restores the production parameters.
	beforeEach(() => setArgon2ParametersForTesting(TEST_PARAMETERS));

	it("round-trips and rejects wrong passwords", async () => {
		const encoded = await hashPassword("correct horse");
		expect(encoded).toMatch(/^\$argon2id\$v=19\$m=2048,t=1,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
		expect(await verifyPassword("correct horse", encoded)).toBe(true);
		expect(await verifyPassword("wrong horse", encoded)).toBe(false);
		expect(await verifyPassword("", encoded)).toBe(false);
		expect(needsRehash(encoded)).toBe(false);
	});

	it("uses the documented production parameters by default", async () => {
		setArgon2ParametersForTesting(DEFAULT_ARGON2_PARAMETERS);
		expect(DEFAULT_ARGON2_PARAMETERS).toEqual({ memory: 65536, passes: 3, parallelism: 1 });
		const encoded = await hashPassword("correct horse");
		expect(encoded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
		expect(await verifyPassword("correct horse", encoded)).toBe(true);
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

	it("returns false for malformed encodings, including old scrypt hashes", async () => {
		const salt = base64(Buffer.alloc(16, 7));
		const tag = base64(Buffer.alloc(32, 9));
		const bad = [
			"",
			"garbage",
			// A pre-Argon2 hash is simply invalid now; no migration is needed.
			"scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			"$argon2id$v=19$m=2048,t=1,p=1$abc$def",
			`$argon2i$v=19$m=2048,t=1,p=1$${salt}$${tag}`,
			`$argon2id$v=18$m=2048,t=1,p=1$${salt}$${tag}`,
			`$argon2id$v=19$m=1048577,t=3,p=1$${salt}$${tag}`,
			`$argon2id$v=19$m=2048,t=21,p=1$${salt}$${tag}`,
			`$argon2id$v=19$m=2048,t=1,p=17$${salt}$${tag}`,
			`$argon2id$v=19$m=2040,t=1,p=1$${salt}$${tag}`,
			`$argon2id$v=19$t=1,m=2048,p=1$${salt}$${tag}`,
			`$argon2id$v=19$m=2048,t=1,p=1$${base64(Buffer.alloc(15, 7))}$${tag}`,
			`$argon2id$v=19$m=2048,t=1,p=1$${salt}$${base64(Buffer.alloc(31, 9))}`,
			`$argon2id$v=19$m=2048,t=1,p=1$${salt.slice(0, -2)}-_$${tag}`,
			`$argon2id$v=19$m=2048,t=1,p=1$AAAA AAAA$${tag}`,
		];
		for (const encoded of bad) {
			expect(await verifyPassword("pw", encoded), encoded).toBe(false);
			expect(needsRehash(encoded), encoded).toBe(true);
		}
	});

	it("rejects tampered parameters and flags a changed parameter set for rehash", async () => {
		const encoded = await hashPassword("pw");
		const [, , , , salt, hash] = encoded.split("$");
		// Valid PHC, but a different m derives a different key.
		expect(await verifyPassword("pw", `$argon2id$v=19$m=4096,t=1,p=1$${salt}$${hash}`)).toBe(false);
		expect(await verifyPassword("pw", `$argon2id$v=19$m=1024,t=1,p=1$${salt}$${hash}`)).toBe(false);

		setArgon2ParametersForTesting({ memory: 4096, passes: 1, parallelism: 1 });
		expect(needsRehash(encoded)).toBe(true);
		// Verification uses the parameters embedded in the hash, not the current ones.
		expect(await verifyPassword("pw", encoded)).toBe(true);
		expect(needsRehash(await hashPassword("pw"))).toBe(false);
	});
});

describe("Argon2id concurrency gate", () => {
	afterEach(() => resetHashGateForTesting());

	it("runs one computation, lets one wait, and rejects the third with HashBusyError", async () => {
		resetHashGateForTesting({ concurrency: 1, queue: 1 });
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = withHashSlot(async () => {
			await hold;
			return 1;
		});
		const second = withHashSlot(async () => 2);
		await expect(withHashSlot(async () => 3)).rejects.toBeInstanceOf(HashBusyError);
		release();
		await expect(first).resolves.toBe(1);
		await expect(second).resolves.toBe(2);
	});

	it("releases the slot when the computation throws", async () => {
		resetHashGateForTesting({ concurrency: 1, queue: 0 });
		await expect(
			withHashSlot(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(withHashSlot(async () => 7)).resolves.toBe(7);
	});

	it("keeps a slot for a login while other hashes use theirs", async () => {
		// Two slots: other may hold one, so a login still starts at once even with other work queued.
		resetHashGateForTesting({ concurrency: 2, queue: 4 });
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const other = withHashSlot(async () => {
			await hold;
			return "other";
		}, "other");
		// This one waits: other already holds its one allowed slot.
		const queuedOther = withHashSlot(async () => "queued-other", "other");
		// The login passes the waiting other and runs in the reserved slot.
		await expect(withHashSlot(async () => "login", "login")).resolves.toBe("login");
		release();
		await expect(other).resolves.toBe("other");
		await expect(queuedOther).resolves.toBe("queued-other");
	});

	it("caps other's queue share while login may use the whole queue", async () => {
		// Four queue places, so other may wait for two; the third other is rejected even though the
		// login queue behind it would still have room.
		resetHashGateForTesting({ concurrency: 1, queue: 4 });
		let release: () => void = () => {};
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = withHashSlot(async () => {
			await hold;
		}, "other");
		const second = withHashSlot(async () => {}, "other");
		const third = withHashSlot(async () => {}, "other");
		await expect(withHashSlot(async () => {}, "other")).rejects.toBeInstanceOf(HashBusyError);
		const login = withHashSlot(async () => "login", "login");
		release();
		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
		await expect(third).resolves.toBeUndefined();
		await expect(login).resolves.toBe("login");
	});
});

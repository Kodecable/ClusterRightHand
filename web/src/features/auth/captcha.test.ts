import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { loginTag } from "./captcha";

/** The server's definition, straight from node:crypto (server/src/auth/captcha.ts). */
function nodeTag(username: string, password: string): string {
	return createHash("sha256")
		.update(username, "utf8")
		.update(Buffer.from([0]))
		.update(password, "utf8")
		.digest("base64url");
}

describe("loginTag", () => {
	test("matches a known vector from the server", () => {
		// Verified with: createHash("sha256").update(u).update([0]).update(p).digest("base64url")
		expect(loginTag("root", "admin-password")).toBe("qkM4oq8wYwxn1O_13vntE2IvywN4IqoUPY9RB1eE3mI");
		expect(loginTag("alice", "alice-password")).toBe("257n4mIyFVWXHMcFX2vEOcuT2EhuoW_uZNK8P9TU4Oo");
	});

	test("hashes the exact submitted UTF-8 bytes, with no trimming or normalisation", () => {
		const vectors: [string, string][] = [
			["", ""],
			[" root ", " admin-password "],
			["用户名", "密码"],
			// NFC and NFD spellings must stay different: the server does no normalisation either.
			["\u00e9", "e\u0301"],
		];
		for (const [username, password] of vectors) {
			const tag = loginTag(username, password);
			expect(tag).toBe(nodeTag(username, password));
			expect(tag).toHaveLength(43);
			expect(tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
		}
	});
});

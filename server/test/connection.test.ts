import { describe, expect, it } from "vitest";
import { closeReason } from "../src/cluster/connection.ts";

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

describe("closeReason", () => {
	it("truncates multibyte text to 123 bytes on a code point boundary", () => {
		const reason = `protocol error: ${"事件".repeat(60)}`;
		const fitted = closeReason(reason);
		expect(byteLength(fitted)).toBeLessThanOrEqual(123);
		expect(fitted.isWellFormed()).toBe(true);
		expect(reason.startsWith(fitted)).toBe(true);
		expect(fitted.length).toBeGreaterThan(0);
	});

	it("does not split a surrogate pair", () => {
		const fitted = closeReason(`${"a".repeat(120)}😀`);
		expect(fitted).toBe("a".repeat(120));
		expect(fitted.isWellFormed()).toBe(true);
	});

	it("replaces lone surrogates", () => {
		const fitted = closeReason("bad \ud800");
		expect(fitted).toBe("bad \uFFFD");
		expect(fitted.isWellFormed()).toBe(true);
	});

	it("leaves a short reason unchanged", () => {
		const reason = "protocol_major mismatch: server 1, client 2";
		expect(closeReason(reason)).toBe(reason);
	});
});

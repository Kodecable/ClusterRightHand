import { describe, expect, it } from "vitest";
import { resolveClientAddress } from "../src/api/client-address.ts";

const DIRECT = "127.0.0.1";

describe("resolveClientAddress", () => {
	it("uses the direct remote address when no header is configured", () => {
		expect(resolveClientAddress(DIRECT, undefined, "203.0.113.7")).toBe(DIRECT);
	});

	it("uses the first non-empty element of a configured header", () => {
		expect(resolveClientAddress(DIRECT, "X-Forwarded-For", "203.0.113.7, 198.51.100.4")).toBe("203.0.113.7");
		expect(resolveClientAddress(DIRECT, "X-Forwarded-For", " 203.0.113.7 ,198.51.100.4")).toBe("203.0.113.7");
		// Empty elements before the first real one are skipped, but there is no right-to-left walk.
		expect(resolveClientAddress(DIRECT, "X-Forwarded-For", ", , 203.0.113.7, 198.51.100.4")).toBe("203.0.113.7");
	});

	it("falls back to the direct address when the configured header is absent", () => {
		expect(resolveClientAddress(DIRECT, "X-Real-IP", undefined)).toBe(DIRECT);
	});

	it("falls back to the direct address when the configured header is empty", () => {
		expect(resolveClientAddress(DIRECT, "X-Forwarded-For", "")).toBe(DIRECT);
		expect(resolveClientAddress(DIRECT, "X-Forwarded-For", " , , ")).toBe(DIRECT);
	});
});

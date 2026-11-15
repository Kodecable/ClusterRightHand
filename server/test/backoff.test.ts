import { describe, expect, it } from "vitest";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelay } from "../src/util/backoff.ts";

describe("backoffDelay", () => {
	it("waits 1 s before the first retry, doubling after that", () => {
		const middle = { random: () => 0.5 };
		expect(backoffDelay(1, middle)).toBe(1_000);
		expect(backoffDelay(2, middle)).toBe(2_000);
		expect(backoffDelay(3, middle)).toBe(4_000);
	});

	it("applies the jitter band around the exponential value", () => {
		expect(backoffDelay(2, { random: () => 0 })).toBe(1_600);
		expect(backoffDelay(2, { random: () => 1 })).toBe(2_400);
	});

	it("never exceeds the cap after jitter, including the default 5 minutes", () => {
		const high = { random: () => 1 };
		expect(backoffDelay(30, high)).toBe(BACKOFF_MAX_MS);
		expect(backoffDelay(30, { random: () => 1, baseMs: 1_000, maxMs: 5_000 })).toBe(5_000);
		// The exponential is capped before jitter, and the jittered result is capped again.
		expect(backoffDelay(30, { random: () => 1, maxMs: 5_000 })).toBeLessThanOrEqual(5_000);
		expect(backoffDelay(1, { random: () => 1 })).toBe(Math.round(BACKOFF_BASE_MS * 1.2));
	});
});

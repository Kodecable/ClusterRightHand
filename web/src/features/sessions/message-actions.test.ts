import { describe, expect, test } from "vitest";
import { replyFinishedAt } from "./message-actions";

describe("replyFinishedAt", () => {
	test("adds the duration to the start, and falls back to the start without one", () => {
		expect(replyFinishedAt({ at: 1_000, durationMs: 500 })).toBe(1_500);
		expect(replyFinishedAt({ at: 1_000 })).toBe(1_000);
		expect(replyFinishedAt({ durationMs: 500 })).toBeUndefined();
	});
});

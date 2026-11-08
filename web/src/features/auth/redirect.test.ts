import { describe, expect, test } from "vitest";
import { safeRedirectPath } from "./redirect";

describe("safeRedirectPath", () => {
	test("accepts same-origin absolute paths, trimming surrounding whitespace", () => {
		expect(safeRedirectPath("/approvals/tasks/t1")).toBe("/approvals/tasks/t1");
		expect(safeRedirectPath("/sessions/abc?x=1#y")).toBe("/sessions/abc?x=1#y");
		expect(safeRedirectPath("  /batch  ")).toBe("/batch");
	});

	test("rejects schemes, protocol-relative URLs, backslashes, whitespace and dot segments", () => {
		for (const value of [
			"https://evil.example.com",
			"//evil.example.com",
			"\\\\evil.example.com",
			"javascript:alert(1)",
			"relative/path",
			"/ok\\..\\evil",
			"/ok\u0000",
			"/ok\nheader",
			"/has space",
			"/has\ttab",
			"/a/../../etc/passwd",
			"/a/./b",
			"",
			"   ",
			undefined,
			null,
		]) {
			expect(safeRedirectPath(value), JSON.stringify(value)).toBeUndefined();
		}
	});
});

import { describe, expect, test } from "vitest";
import { safeRedirectPath } from "./redirect";

describe("safeRedirectPath", () => {
	test("accepts same-origin paths", () => {
		expect(safeRedirectPath("/approvals/tasks/t1")).toBe("/approvals/tasks/t1");
		expect(safeRedirectPath("/sessions/abc?x=1#y")).toBe("/sessions/abc?x=1#y");
	});

	test("rejects absolute, protocol-relative, backslash and control-character targets", () => {
		for (const value of [
			"https://evil.example.com",
			"//evil.example.com",
			"\\\\evil.example.com",
			"javascript:alert(1)",
			"/ok\\..\\evil",
			"/ok\u0000",
			"/ok\nheader",
			"",
			undefined,
			null,
		]) {
			expect(safeRedirectPath(value), JSON.stringify(value)).toBeUndefined();
		}
	});
});

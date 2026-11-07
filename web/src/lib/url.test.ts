import { describe, expect, test } from "vitest";
import { inspectUrl, safeInternalPath, safeUrlTransform } from "./url";

describe("inspectUrl", () => {
	test("allows http, https and mailto case-insensitively", () => {
		for (const url of [
			"http://example.com/a?b=1",
			"https://example.com",
			"HTTP://EXAMPLE.COM",
			"hTtPs://example.com/x",
			"mailto:oncall@example.com",
			"  https://example.com/padded  ",
		]) {
			expect(inspectUrl(url).allowed, url).toBe(true);
		}
		expect(inspectUrl("https://example.com")?.url).toBe("https://example.com");
	});

	test("rejects other schemes, relative URLs and protocol-relative URLs", () => {
		for (const url of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(2)",
			"data:text/html,<script>alert(3)</script>",
			"file:///etc/passwd",
			"vbscript:msgbox(4)",
			"ftp://example.com",
			"//evil.example.com",
			"../relative",
			"/absolute",
			"#anchor",
			"",
			"   ",
			null,
			undefined,
			42,
		]) {
			expect(inspectUrl(url).allowed, String(url)).toBe(false);
		}
	});

	test("rejects schemes hidden by control characters or character references", () => {
		for (const url of [
			"\u0000javascript:alert(1)",
			"java\u0009script:alert(1)",
			"java\u000Ascript:alert(1)",
			"java\u000Dscript:alert(1)",
			"java%09script:alert(1)",
			// react-markdown decodes these before calling the transform; a URL that
			// still has them has no colon where a scheme would be and is rejected.
			"jav&#x61;script:alert(1)",
			"jav&#97;script:alert(1)",
			"javascript&#58;alert(1)",
			"java&Tab;script:alert(1)",
			"java&NewLine;script:alert(1)",
		]) {
			expect(inspectUrl(url).allowed, JSON.stringify(url)).toBe(false);
		}
	});

	test("keeps a literal &amp; in the query instead of decoding it again", () => {
		const url = "https://example.com/search?q=a&amp;b=1";
		expect(inspectUrl(url)).toEqual({ allowed: true, url, scheme: "https:" });
		expect(safeUrlTransform(url)).toBe(url);
	});

	test("safeUrlTransform returns the URL or an empty string", () => {
		expect(safeUrlTransform("https://example.com")).toBe("https://example.com");
		expect(safeUrlTransform("  https://example.com  ")).toBe("https://example.com");
		expect(safeUrlTransform("javascript:alert(1)")).toBe("");
	});
});

describe("safeInternalPath", () => {
	test("keeps same-origin absolute paths", () => {
		expect(safeInternalPath("/approvals/tasks/t-1")).toBe("/approvals/tasks/t-1");
		expect(safeInternalPath("/sessions/s-1?x=1#y")).toBe("/sessions/s-1?x=1#y");
		expect(safeInternalPath("  /batch  ")).toBe("/batch");
	});

	test("rejects schemes, protocol-relative URLs, backslashes and dot segments", () => {
		for (const value of [
			"https://evil.example.com/x",
			"//evil.example.com/x",
			"/\\evil.example.com",
			"/a/../../etc/passwd",
			"/a/./b",
			"javascript:alert(1)",
			"relative/path",
			"/has space",
			"/has\ttab",
			"",
			null,
			42,
		]) {
			expect(safeInternalPath(value), String(value)).toBeUndefined();
		}
	});
});

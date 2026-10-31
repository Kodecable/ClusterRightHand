import { describe, expect, test } from "vitest";
import {
	decodeCharacterReferences,
	inspectUrl,
	isSafeUrl,
	safeHashLink,
	safeInternalPath,
	safeUrlTransform,
} from "./url";

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
			expect(isSafeUrl(url), String(url)).toBe(false);
		}
	});

	test("decodes character references before checking the scheme", () => {
		for (const url of [
			"jav&#x61;script:alert(1)",
			"jav&#97;script:alert(1)",
			"jav&#0000097;script:alert(1)",
			"javascript&#58;alert(1)",
			"java&Tab;script:alert(1)",
			"java&NewLine;script:alert(1)",
			"java%09script:alert(1)",
			"\u0000javascript:alert(1)",
			"java\u0009script:alert(1)",
			"java\u000Ascript:alert(1)",
			"java\u000Dscript:alert(1)",
		]) {
			expect(isSafeUrl(url), JSON.stringify(url)).toBe(false);
		}
	});

	test("decodeCharacterReferences decodes numeric and named entities", () => {
		expect(decodeCharacterReferences("a&#x41;b")).toBe("aAb");
		expect(decodeCharacterReferences("a&#65;b")).toBe("aAb");
		expect(decodeCharacterReferences("a&amp;b")).toBe("a&b");
		expect(decodeCharacterReferences("a&colon;b")).toBe("a:b");
		expect(decodeCharacterReferences("a&unknown;b")).toBe("a&unknown;b");
	});

	test("safeUrlTransform returns the URL or an empty string", () => {
		expect(safeUrlTransform("https://example.com")).toBe("https://example.com");
		expect(safeUrlTransform("  https://example.com  ")).toBe("https://example.com");
		expect(safeUrlTransform("javascript:alert(1)")).toBe("");
	});
});

describe("safeHashLink", () => {
	test("keeps only same-origin hash paths", () => {
		expect(safeHashLink("http://h:1/#/approvals/tasks/abc")).toBe("#/approvals/tasks/abc");
		expect(safeHashLink("#/tasks/t-1")).toBe("#/tasks/t-1");
		expect(safeHashLink("javascript:alert(1)")).toBeUndefined();
		expect(safeHashLink("#/tasks/../../etc")).toBeUndefined();
		expect(safeHashLink("")).toBeUndefined();
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

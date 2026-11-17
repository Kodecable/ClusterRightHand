import { SESSION_TITLE_MAX_CHARS } from "@crh/api";
import { describe, expect, it } from "vitest";
import { forkedSessionTitle } from "../src/sessions/titles.ts";

/**
 * A fork's title (doc/design/agent-runtime.md "Forking"): the source title plus the owner's localized suffix,
 * without a second suffix on a fork of a fork and never over the shared code-point limit.
 */
describe("forkedSessionTitle", () => {
	it("appends the suffix in both locales", () => {
		expect(forkedSessionTitle("Deploy plan", "en")).toBe("Deploy plan (fork)");
		expect(forkedSessionTitle("部署计划", "zh-CN")).toBe("部署计划（分叉）");
		// A missing locale falls back to English, like the rest of the stored title texts.
		expect(forkedSessionTitle("Deploy plan", null)).toBe("Deploy plan (fork)");
	});

	it("uses the localized default name for an untitled source", () => {
		expect(forkedSessionTitle(null, "en")).toBe("New session (fork)");
		expect(forkedSessionTitle("   ", "zh-CN")).toBe("新会话（分叉）");
	});

	it("cuts a long base so the title stays within the code-point limit", () => {
		for (const locale of ["en", "zh-CN"] as const) {
			const suffix = locale === "en" ? " (fork)" : "（分叉）";
			const title = forkedSessionTitle("x".repeat(SESSION_TITLE_MAX_CHARS), locale);
			expect(Array.from(title)).toHaveLength(SESSION_TITLE_MAX_CHARS);
			expect(title.endsWith(suffix)).toBe(true);
			expect(title).toBe(`${"x".repeat(SESSION_TITLE_MAX_CHARS - Array.from(suffix).length)}${suffix}`);
		}
	});

	it("counts code points, not UTF-16 units, when cutting", () => {
		// Each astral character is one code point but two UTF-16 units.
		const title = forkedSessionTitle("😀".repeat(SESSION_TITLE_MAX_CHARS), "en");
		expect(Array.from(title)).toHaveLength(SESSION_TITLE_MAX_CHARS);
		expect(title.endsWith(" (fork)")).toBe(true);
	});

	it("does not stack a suffix a fork of a fork already carries", () => {
		expect(forkedSessionTitle("Deploy plan (fork)", "en")).toBe("Deploy plan (fork)");
		expect(forkedSessionTitle("部署计划（分叉）", "zh-CN")).toBe("部署计划（分叉）");
		// Either locale's suffix stops a second one, whatever the owner's current language is.
		expect(forkedSessionTitle("部署计划（分叉）", "en")).toBe("部署计划（分叉）");
		expect(forkedSessionTitle("Deploy plan (fork)", "zh-CN")).toBe("Deploy plan (fork)");
	});
});

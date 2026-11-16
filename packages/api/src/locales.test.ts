import { describe, expect, it } from "vitest";
import { LOCALE_REGISTRY, matchLocale } from "./locales.ts";

describe("matchLocale", () => {
	it("matches English tags case-insensitively", () => {
		expect(matchLocale(["en"])).toBe("en");
		expect(matchLocale(["EN-us"])).toBe("en");
		expect(matchLocale(["en-GB"])).toBe("en");
		expect(matchLocale(["en-AU"])).toBe("en");
	});

	it("matches Simplified Chinese tags and their prefixes", () => {
		for (const tag of ["zh", "zh-CN", "zh-Hans", "zh-Hans-CN", "zh-SG", "zh-MY", "zh-hans-sg"]) {
			expect(matchLocale([tag])).toBe("zh-CN");
		}
		// A longer tag falls back subtag by subtag.
		expect(matchLocale(["zh-Hans-TW"])).toBe("zh-CN");
		// Extensions are dropped by the lookup.
		expect(matchLocale(["en-US-u-hc-h12"])).toBe("en");
	});

	it("routes the Traditional Chinese family to zh-CN by explicit registry entry", () => {
		for (const tag of ["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "zh-Hant-TW"]) {
			expect(matchLocale([tag])).toBe("zh-CN");
		}
	});

	it("returns the first resolvable tag and null when nothing is supported", () => {
		expect(matchLocale(["de-DE", "fr", "zh-TW", "en"])).toBe("zh-CN");
		expect(matchLocale(["de-DE", "fr"])).toBeNull();
		expect(matchLocale([])).toBeNull();
		expect(matchLocale([""])).toBeNull();
		expect(matchLocale(["*"])).toBeNull();
	});

	it("accepts underscores as separators", () => {
		expect(matchLocale(["zh_cn"])).toBe("zh-CN");
		expect(matchLocale(["en_us"])).toBe("en");
	});

	it("registers every locale", () => {
		expect(new Set(LOCALE_REGISTRY.map((entry) => entry.locale))).toEqual(new Set(["en", "zh-CN"]));
	});
});

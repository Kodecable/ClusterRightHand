import { describe, expect, it } from "vitest";
import { EMOJI_MAX_UTF16_UNITS, normalizeEmoji } from "../src/util/emoji.ts";

describe("normalizeEmoji", () => {
	it("keeps one RGI emoji, including flags, skin tones, ZWJ sequences and keycaps", () => {
		for (const emoji of ["😀", "🇨🇳", "👍🏽", "👨‍👩‍👧", "1️⃣", "❤️", "🏳️‍🌈"]) {
			expect(normalizeEmoji(emoji)).toBe(emoji);
		}
	});

	it("trims surrounding whitespace and treats null or blank as no emoji", () => {
		expect(normalizeEmoji("  🚀  ")).toBe("🚀");
		expect(normalizeEmoji(null)).toBeNull();
		expect(normalizeEmoji("")).toBeNull();
		expect(normalizeEmoji("   ")).toBeNull();
	});

	it("rejects more than one character, non-emoji digits and text symbols", () => {
		for (const value of ["ab", "😀😀", "1", "12", "©", "abc", "😀 🚀"]) {
			expect(() => normalizeEmoji(value), value).toThrow(/one emoji/);
		}
	});

	it("rejects a value longer than the sanity cap", () => {
		expect(EMOJI_MAX_UTF16_UNITS).toBe(32);
		// 17 flags are 34 UTF-16 units; the length check fires before the grapheme check.
		expect(() => normalizeEmoji("🇨🇳".repeat(17))).toThrow(/UTF-16 code units/);
	});
});

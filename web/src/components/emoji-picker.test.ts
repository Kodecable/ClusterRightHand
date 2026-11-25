import type { EmojiData } from "frimousse";
import { describe, expect, test } from "vitest";
import { isRgiEmoji, supportedEmojiData } from "./emoji-picker";

/** Emojibase's shape for one emoji, with the fields the picker's data resolver keeps. */
function emoji(emoji: string, version: number) {
	return { emoji, category: 0, label: emoji, version, tags: [] as string[] };
}

const DATA: EmojiData = {
	locale: "en",
	emojis: [emoji("😀", 1), emoji("🫫", 18)],
	categories: [{ index: 0, label: "Smileys & emotion" }],
	skinTones: {
		light: "🏻",
		"medium-light": "🏼",
		medium: "🏽",
		"medium-dark": "🏾",
		dark: "🏿",
	},
};

describe("emoji picker RGI filter", () => {
	test("drops an Emoji 18 entry that crhs's RGI check rejects", () => {
		// Emojibase 18 ships Emoji 18; the JavaScript engine's RGI set (and therefore crhs's validator)
		// may stop earlier, so the picker must not offer an emoji the server would refuse.
		expect(isRgiEmoji("🫫")).toBe(false);
		const filtered = supportedEmojiData(DATA);
		expect(filtered.emojis.map((entry) => entry.emoji)).toEqual(["😀"]);
		// The rest of the data is untouched.
		expect(filtered.categories).toEqual(DATA.categories);
		expect(filtered.skinTones).toEqual(DATA.skinTones);
		expect(DATA.emojis).toHaveLength(2);
	});

	test("keeps an ordinary smiley and a ZWJ family", () => {
		expect(isRgiEmoji("😀")).toBe(true);
		expect(isRgiEmoji("👨‍👩‍👧‍👦")).toBe(true);
	});
});

import { UserError } from "./errors.ts";

/**
 * The sanity cap on a stored emoji in UTF-16 code units. One grapheme cluster is at most a few dozen; the
 * limit only stops a pathological input from being stored at all.
 */
export const EMOJI_MAX_UTF16_UNITS = 32;

/** Grapheme clusters, so a ZWJ family, a flag or a keycap counts as one character. */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Exactly one RGI emoji (Unicode's recommended set: flags, skin tones, ZWJ sequences and keycaps); plain
 * digits and text symbols are not emoji. The `v` flag needs Node >= 24, which crhs requires.
 */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/**
 * The stored form of a node's or node group's emoji (doc/design/data-model.md "Nodes",
 * doc/design/webui.md "Node pages"): null, or exactly one grapheme cluster that is an RGI emoji. The
 * value is trimmed, and null or a blank string means no emoji.
 */
export function normalizeEmoji(raw: string | null): string | null {
	if (raw === null) return null;
	const emoji = raw.trim();
	if (emoji === "") return null;
	if (emoji.length > EMOJI_MAX_UTF16_UNITS) {
		throw new UserError(`emoji: at most ${EMOJI_MAX_UTF16_UNITS} UTF-16 code units are allowed`);
	}
	if ([...segmenter.segment(emoji)].length !== 1) throw new UserError("emoji: exactly one emoji is allowed");
	if (!RGI_EMOJI.test(emoji)) throw new UserError("emoji: exactly one emoji is allowed");
	return emoji;
}

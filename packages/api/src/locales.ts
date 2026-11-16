/**
 * The languages crhs speaks, shared by the server (chat texts) and the WebUI (interface language).
 *
 * This is the one registry: a locale and the BCP 47 tags it accepts. Resolution uses RFC 4647 lookup —
 * tags are compared case-insensitively, and a tag with more subtags falls back to its prefix, so `en-GB`
 * finds `en` and `zh-Hans-TW` finds `zh-Hans`. An unknown tag returns null, so each caller can fall
 * through to its next source (the stored user setting, the platform's language, English).
 *
 * There is no Traditional Chinese catalogue yet, so the `zh-Hant` family resolves to `zh-CN` through an
 * explicit registry entry instead of silently falling back to English.
 */

/** The locales crhs ships catalogues for. */
export const LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

export interface LocaleRegistryEntry {
	/** The catalogue this entry resolves to. */
	locale: Locale;
	/** The tags it accepts; lookup also accepts a longer tag whose prefix is here. */
	tags: readonly string[];
}

export const LOCALE_REGISTRY: readonly LocaleRegistryEntry[] = [
	{
		locale: "en",
		tags: ["en", "en-US", "en-GB"],
	},
	{
		locale: "zh-CN",
		// Simplified Chinese (the catalogue is Simplified). `zh` is the bare language, `zh-SG`/`zh-MY`
		// are Simplified in practice, and the `zh-Hant` family is routed here because no Traditional
		// Chinese catalogue exists yet (documented above and in doc/design/webui.md "Shell, theme and language").
		tags: ["zh", "zh-CN", "zh-Hans", "zh-Hans-CN", "zh-SG", "zh-MY", "zh-Hant", "zh-TW", "zh-HK", "zh-MO"],
	},
];

const TAG_TO_LOCALE: ReadonlyMap<string, Locale> = new Map(
	LOCALE_REGISTRY.flatMap((entry) => entry.tags.map((tag) => [normalizeTag(tag), entry.locale] as const)),
);

function normalizeTag(tag: string): string {
	return tag.trim().toLowerCase().replaceAll("_", "-");
}

/**
 * RFC 4647 lookup over a caller's ordered language tags (`navigator.languages`, a platform's
 * `language_code`, an `Accept-Language` list). The first tag that resolves wins; null means no
 * supported locale.
 */
export function matchLocale(tags: readonly string[]): Locale | null {
	for (const raw of tags) {
		let candidate = normalizeTag(raw);
		// A wildcard is not a locale; it does not select a catalogue by itself.
		if (candidate === "" || candidate === "*") continue;
		for (;;) {
			const locale = TAG_TO_LOCALE.get(candidate);
			if (locale !== undefined) return locale;
			const cut = candidate.lastIndexOf("-");
			if (cut <= 0) break;
			candidate = candidate.slice(0, cut);
		}
	}
	return null;
}

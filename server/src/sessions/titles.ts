import type { UserSettingsLocale } from "@crh/api";

/**
 * The localized names crhs writes into session rows: the default name of an untitled session and the suffix a
 * fork's title carries (doc/design/agent-runtime.md "Forking"). The WebUI's catalogue has the same words; a
 * stored title is data from then on, so these are the only server-side session title texts. The chat cards'
 * "New session" wording comes from `untitledSessionTitle` too (`channels/messages.ts`), so the server has one
 * definition of it.
 */

interface SessionTitleWords {
	/** What a null or blank title reads as. */
	untitled: string;
	/** Appended to the source title; the catalogue owns the spacing and punctuation. */
	forkSuffix: string;
}

const WORDS: Record<"en" | "zh-CN", SessionTitleWords> = {
	en: { untitled: "New session", forkSuffix: " (fork)" },
	"zh-CN": { untitled: "新会话", forkSuffix: "（分叉）" },
};

/** A stored user locale (or the caller's fallback) as one of the catalogues crhs writes. */
export function titleLocale(locale: UserSettingsLocale | null | undefined): "en" | "zh-CN" {
	return locale === "zh-CN" ? "zh-CN" : "en";
}

/** What an untitled session reads as in this language. */
export function untitledSessionTitle(locale: UserSettingsLocale | null | undefined): string {
	return WORDS[titleLocale(locale)].untitled;
}

/** A stored title as it is displayed: the title itself, or the localized default when it is null or blank. */
export function displayedSessionTitle(
	title: string | null | undefined,
	locale: UserSettingsLocale | null | undefined,
): string {
	return title?.trim() ? title : untitledSessionTitle(locale);
}

/**
 * A fork's title: the source title (or the localized default for an untitled source) plus the localized fork
 * suffix. A retry with the same request id returns the row this produced, so the title is stable.
 */
export function forkedSessionTitle(
	sourceTitle: string | null | undefined,
	locale: UserSettingsLocale | null | undefined,
): string {
	const words = WORDS[titleLocale(locale)];
	const base = sourceTitle?.trim() ? sourceTitle : words.untitled;
	return `${base}${words.forkSuffix}`;
}

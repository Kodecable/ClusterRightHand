import { LOCALES, type Locale, matchLocale } from "@crh/api";
import { readStorage } from "./storage";

export type { Locale };
export { LOCALES };

export const LOCALE_STORAGE_KEY = "crh.locale";

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Initial language: an explicit user override first, then `navigator.languages` through the shared
 * registry (RFC 4647 lookup: `zh-TW` and `zh-Hans` select zh-CN, `en-GB` selects en), else English. Kept
 * in its own module without the Lingui/React imports so the startup path can resolve it before the rest
 * of the entry has evaluated.
 */
export function resolveInitialLocale(): Locale {
	const stored = readStorage(LOCALE_STORAGE_KEY);
	if (isLocale(stored)) return stored;
	const languages =
		typeof navigator === "undefined"
			? ["en"]
			: navigator.languages !== undefined && navigator.languages.length > 0
				? navigator.languages
				: [navigator.language];
	return matchLocale(languages) ?? "en";
}

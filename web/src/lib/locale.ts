import { readStorage } from "./storage";

export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_STORAGE_KEY = "crh.locale";

export function isLocale(value: unknown): value is Locale {
	return value === "en" || value === "zh-CN";
}

/**
 * Initial language: an explicit user override first, then `navigator.languages`
 * (`zh*` → zh-CN, anything else → en). Kept in its own module without the
 * Lingui/React imports so the startup path can resolve it before the rest of
 * the entry has evaluated.
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
	return languages.some((language) => /^zh/i.test(language)) ? "zh-CN" : "en";
}

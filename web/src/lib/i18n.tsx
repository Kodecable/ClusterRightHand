import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { readStorage, writeStorage } from "@/lib/storage";

export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_STORAGE_KEY = "crh.locale";

export function isLocale(value: unknown): value is Locale {
	return value === "en" || value === "zh-CN";
}

/**
 * Initial language: an explicit user override first, then `navigator.languages`
 * (`zh*` → zh-CN, anything else → en).
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

async function loadCatalog(locale: Locale): Promise<Record<string, string>> {
	// The Vite plugin compiles .po catalogs on import. The source locale needs a
	// catalog too: macros compile to message ids, so the English strings live in
	// en.po exactly like the translations live in zh-CN.po.
	const catalog = locale === "en" ? await import("@/locales/en.po") : await import("@/locales/zh-CN.po");
	return catalog.messages;
}

/**
 * Load a catalog and activate it in the shared i18n instance. React subscribers
 * re-render on `activate`, so switching does not reload the page.
 */
export async function activateLocale(locale: Locale): Promise<void> {
	const messages = await loadCatalog(locale);
	i18n.loadAndActivate({ locale, messages });
	document.documentElement.lang = locale;
}

export function currentLocale(): Locale {
	return isLocale(i18n.locale) ? i18n.locale : "en";
}

interface LocaleContextValue {
	locale: Locale;
	switching: boolean;
	setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(initialLocale);
	const [switching, setSwitching] = useState(false);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	const setLocale = useCallback(
		(next: Locale) => {
			if (next === locale) return;
			setSwitching(true);
			void activateLocale(next).then(() => {
				writeStorage(LOCALE_STORAGE_KEY, next);
				setLocaleState(next);
				setSwitching(false);
			});
		},
		[locale],
	);

	const value = useMemo(() => ({ locale, switching, setLocale }), [locale, switching, setLocale]);
	return (
		<LocaleContext.Provider value={value}>
			<I18nProvider i18n={i18n}>{children}</I18nProvider>
		</LocaleContext.Provider>
	);
}

export function useLocale(): LocaleContextValue {
	const context = useContext(LocaleContext);
	if (!context) throw new Error("useLocale must be used inside LocaleProvider");
	return context;
}

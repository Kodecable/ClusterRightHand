import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { LOCALE_STORAGE_KEY, type Locale } from "@/lib/locale";
import { writeStorage } from "@/lib/storage";

export { isLocale, LOCALE_STORAGE_KEY, LOCALES, type Locale, resolveInitialLocale } from "@/lib/locale";

/*
 * Rules for translatable text (the chat catalogue, server/src/channels/messages.ts, follows the same ones):
 *
 * 1. One message per sentence or line, with values as placeholders: `Nodes: {list}` → `节点：{list}`. Never
 *    concatenate translated fragments, and never add punctuation or spaces next to a translation in code: the
 *    translation owns its colon, spacing and word order (a full-width `：` takes no space after it).
 * 2. Lists go through `Intl.ListFormat(locale, { type: "conjunction", style: "narrow" })`, which gives
 *    `a, b, c` and `a、b、c`; never `join(", ")`.
 * 3. Plurals are ICU plural forms inside the message, not code branches; numbers, dates and sizes use the
 *    active locale's formatters.
 * 4. Code may only put language-neutral layout between whole messages: the ` · ` separator and line breaks.
 * 5. Chinese translations use full-width punctuation (：，（）“”、) and keep the spacing between Chinese and
 *    Latin text the way the translation writes it.
 */

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

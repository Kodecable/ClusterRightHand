import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { readStorage, writeStorage } from "@/lib/storage";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "crh.theme";

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

export function readThemePreference(): ThemePreference {
	const stored = readStorage(THEME_STORAGE_KEY);
	return isThemePreference(stored) ? stored : "system";
}

export function systemTheme(): ResolvedTheme {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
	if (preference === "light" || preference === "dark") return preference;
	return systemTheme();
}

function paint(resolved: ResolvedTheme): void {
	const root = document.documentElement;
	root.setAttribute("data-theme", resolved);
	root.style.colorScheme = resolved;
}

export interface ThemeContextValue {
	preference: ThemePreference;
	resolved: ResolvedTheme;
	setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Theme preference: `system | light | dark`, persisted in localStorage and
 * materialised as `data-theme` on <html>. The inline script in index.html does
 * the same work before the first paint; this provider keeps React state and the
 * OS listener in sync afterwards.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
	const [preference, setPreferenceState] = useState<ThemePreference>(readThemePreference);
	const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemePreference()));

	useEffect(() => {
		const next = resolveTheme(preference);
		setResolved(next);
		paint(next);
		writeStorage(THEME_STORAGE_KEY, preference);
		if (preference !== "system") return;
		if (typeof window.matchMedia !== "function") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			const systemResolved = systemTheme();
			setResolved(systemResolved);
			paint(systemResolved);
		};
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [preference]);

	const setPreference = useCallback((next: ThemePreference) => {
		setPreferenceState(next);
	}, []);

	const value = useMemo(() => ({ preference, resolved, setPreference }), [preference, resolved, setPreference]);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
	const context = useContext(ThemeContext);
	if (!context) throw new Error("useTheme must be used inside ThemeProvider");
	return context;
}

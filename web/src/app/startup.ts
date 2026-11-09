import { sessionPageChunk, sessionsLayoutChunk } from "@/app/lazy-chunks";
import { authStore } from "@/features/auth/session";
import { type Locale, resolveInitialLocale } from "@/lib/locale";

/**
 * The work the first paint waits for, started before the rest of the entry's
 * modules have finished evaluating: the session request, the active locale's
 * catalogue and the lazy chunk of the first route. `main.tsx` imports this
 * module first, so those round trips overlap the evaluation of the app shell
 * and the router instead of starting after it.
 *
 * The imports below are the same modules `activateLocale` and the router's
 * `lazyRouteComponent` request later; the module map hands them the request
 * started here, so nothing is fetched twice.
 */

/**
 * Old links are `#/sessions/:id` (agent transcripts still contain them,
 * doc/webui.md "路由"). Convert one to a real path before the router sees it.
 */
function normaliseLegacyHash(): void {
	const hash = window.location.hash;
	if (!hash.startsWith("#/")) return;
	const path = hash.slice(1);
	// Keep the existing query string (if any) after the converted path.
	const url = `${path}${window.location.search}`;
	try {
		window.history.replaceState(window.history.state, "", url);
	} catch {
		// A malformed old link is left alone; the router will show its not-found page.
	}
}

normaliseLegacyHash();

export const initialLocale: Locale = resolveInitialLocale();
export const initialPath: string = window.location.pathname;

/** The routes that mount the sessions list column, which the first screen waits for. */
export function isSessionsRoute(pathname: string): boolean {
	return pathname === "/" || pathname === "/sessions" || pathname.startsWith("/sessions/");
}

export const authLoad = authStore.load();

// `activateLocale` requests the same module; it resolves from the module map.
if (initialLocale === "en") void import("@/locales/en.po");
else void import("@/locales/zh-CN.po");

if (isSessionsRoute(initialPath)) {
	void sessionsLayoutChunk();
	// The `/sessions` index renders the draft page too, so every sessions path ends on the page chunk.
	void sessionPageChunk();
}

import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers";
import { router } from "@/app/router";
import { authStore } from "@/features/auth/session";
import { createQueryClient } from "@/lib/api/query";
import { activateLocale, resolveInitialLocale } from "@/lib/i18n";
import "./index.css";

declare global {
	interface Window {
		/** Incremented once per app module evaluation; the language e2e test asserts it does not change. */
		__crhAppMounts?: number;
	}
}

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

async function bootstrap(): Promise<void> {
	normaliseLegacyHash();
	// Load and activate the catalogue before the first render so the UI never
	// flashes message ids; the session is restored in the same step so the
	// route guard can run on the first navigation.
	const locale = resolveInitialLocale();
	await activateLocale(locale);
	await authStore.load();

	window.__crhAppMounts = (window.__crhAppMounts ?? 0) + 1;

	const root = document.getElementById("root");
	if (!root) throw new Error("#root not found");

	createRoot(root).render(
		<StrictMode>
			<AppProviders queryClient={createQueryClient()} initialLocale={locale}>
				<RouterProvider router={router} />
			</AppProviders>
		</StrictMode>,
	);
}

void bootstrap();

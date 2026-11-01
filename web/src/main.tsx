// biome-ignore-all assist/source/organizeImports: `./app/startup` must stay the first import so the startup requests begin before the rest of the entry evaluates.
import { authLoad, initialLocale, initialPath, isSessionsRoute } from "./app/startup";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers";
import { router } from "@/app/router";
import { prefetchSessions } from "@/features/sessions/api";
import { createQueryClient } from "@/lib/api/query";
import { activateLocale } from "@/lib/i18n";
import "./index.css";

declare global {
	interface Window {
		/** Incremented once per app module evaluation; the language e2e test asserts it does not change. */
		__crhAppMounts?: number;
	}
}

async function bootstrap(): Promise<void> {
	// `app/startup` already started the session request, the catalogue and the
	// first route's chunk while this module was being evaluated. Only the first
	// session-list page needs the auth result, so it starts as soon as that
	// resolves, in parallel with rendering the shell.
	const queryClient = createQueryClient();
	const catalogue = activateLocale(initialLocale);
	const auth = authLoad.then((state) => {
		if (state.status === "authenticated" && isSessionsRoute(initialPath)) {
			void prefetchSessions(queryClient, {}).catch(() => undefined);
		}
		return state;
	});

	await Promise.all([catalogue, auth]);

	window.__crhAppMounts = (window.__crhAppMounts ?? 0) + 1;

	const root = document.getElementById("root");
	if (!root) throw new Error("#root not found");

	createRoot(root).render(
		<StrictMode>
			<AppProviders queryClient={queryClient} initialLocale={initialLocale}>
				<RouterProvider router={router} />
			</AppProviders>
		</StrictMode>,
	);
}

void bootstrap();

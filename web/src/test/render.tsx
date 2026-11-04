import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { type RenderResult, render } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { messages as enMessages } from "@/locales/en.po";
import { messages as zhMessages } from "@/locales/zh-CN.po";

const CATALOGS = { en: enMessages, "zh-CN": zhMessages } as const;

export type TestLocale = keyof typeof CATALOGS;

/** Activate a catalogue in the shared Lingui instance (tests render real translations). */
export function activateLocale(locale: TestLocale = "en"): void {
	i18n.loadAndActivate({ locale, messages: CATALOGS[locale] });
}

/**
 * A query client for component tests: nothing is stale, so a test that seeds
 * the cache sees the seeded value without a request.
 */
export function testQueryClient(): QueryClient {
	return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
}

/**
 * Render with the providers the app has (theme, locale, query): a component
 * that reads a query must find a client, and an isolated client lets the test
 * seed exactly what it wants.
 */
export function renderWithI18n(
	ui: React.ReactElement,
	locale: TestLocale = "en",
	client: QueryClient = testQueryClient(),
): RenderResult {
	activateLocale(locale);
	return render(ui, {
		wrapper: ({ children }) => (
			<QueryClientProvider client={client}>
				<ThemeProvider>
					<LocaleProvider initialLocale={locale}>{children}</LocaleProvider>
				</ThemeProvider>
			</QueryClientProvider>
		),
	});
}

/**
 * Render a component that uses `<Link>`: a minimal in-memory router registers
 * the paths the components link to and shows the component at the root.
 */
export async function renderWithRouter(ui: React.ReactElement, locale: TestLocale = "en"): Promise<RenderResult> {
	activateLocale(locale);
	const rootRoute = createRootRoute();
	const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => ui });
	const paths = [
		"/tasks",
		"/tasks/$taskId",
		"/approvals/tasks/$taskId",
		"/approvals/task-groups/$taskGroupId",
		"/nodes/$nodeId",
		"/task-groups/$taskGroupId",
		"/sessions/$sessionId",
		"/schedules/$scheduleId",
		"/login",
		"/sessions",
	];
	const children = paths.map((path) =>
		createRoute({ getParentRoute: () => rootRoute, path, component: () => <div /> }),
	);
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, ...children]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	await router.load();
	return render(
		<ThemeProvider>
			<LocaleProvider initialLocale={locale}>
				<RouterProvider router={router} />
			</LocaleProvider>
		</ThemeProvider>,
	);
}

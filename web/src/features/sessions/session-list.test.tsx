import type { AvailableModel } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";
import { authStore } from "@/lib/session";
import { activateLocale } from "@/test/render";
import { SessionList } from "./session-list";
import { closeSessionSearch, SessionSearchDialog } from "./session-search-dialog";

const MODELS: AvailableModel[] = [
	{
		provider: "faux",
		providerName: "faux",
		modelId: "faux-1",
		name: "Faux One",
		contextWindow: 128_000,
		thinkingLevels: ["off"],
		input: ["text"],
	},
];

const DraftStub = () => <div data-testid="draft-stub" />;

async function renderList(initialPath: string) {
	const requests: { path: string; method: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			requests.push({ path: url.pathname, method: init?.method ?? "GET" });
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url.pathname === "/api/models") return json({ models: MODELS });
			if (url.pathname === "/api/sessions") return json({ items: [], nextCursor: null });
			return json({});
		}),
	);
	activateLocale("en");
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	const rootRoute = createRootRoute();
	const sessionsRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/sessions",
		component: () => (
			<>
				<SessionList />
				<SessionSearchDialog />
			</>
		),
	});
	const draftRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/sessions/new",
		component: initialPath === "/sessions/new" ? () => <SessionList /> : DraftStub,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([sessionsRoute, draftRoute]),
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});
	await router.load();
	render(
		<LocaleProvider initialLocale="en">
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</LocaleProvider>,
	);
	return { requests, router };
}

afterEach(() => {
	closeSessionSearch();
	authStore.clear();
	vi.unstubAllGlobals();
});

describe("session list search", () => {
	test("has no title filter input; a search-styled button opens the dialog", async () => {
		await renderList("/sessions");
		const user = userEvent.setup();
		// The old list filter (an input that narrowed the list) is gone.
		expect(screen.queryByTestId("session-search")).toBeNull();
		expect(screen.queryByRole("searchbox")).toBeNull();

		const button = await screen.findByTestId("session-search-open");
		expect(button).toHaveTextContent("Search sessions…");
		expect(button).toHaveTextContent("Ctrl K");
		await user.click(button);
		expect(await screen.findByTestId("session-search-dialog")).toBeInTheDocument();
		await waitFor(() => expect(screen.getByTestId("session-search-input")).toHaveFocus());
	});
});

describe("session list new-session button", () => {
	test("navigates to the draft page without calling the create API", async () => {
		const { requests, router } = await renderList("/sessions");
		const user = userEvent.setup();
		await user.click(await screen.findByTestId("new-session-button"));
		await waitFor(() => expect(router.state.location.pathname).toBe("/sessions/new"));
		expect(screen.getByTestId("draft-stub")).toBeInTheDocument();
		expect(requests.filter((request) => request.path === "/api/sessions" && request.method === "POST")).toEqual([]);
	});

	test("does nothing when the draft page is already open", async () => {
		const { requests, router } = await renderList("/sessions/new");
		const user = userEvent.setup();
		await user.click(await screen.findByTestId("new-session-button"));
		expect(router.state.location.pathname).toBe("/sessions/new");
		expect(requests.filter((request) => request.path === "/api/sessions" && request.method === "POST")).toEqual([]);
	});
});

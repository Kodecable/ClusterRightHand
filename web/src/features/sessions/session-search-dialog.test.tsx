import type { SessionSearchItem, SessionSearchPage } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LocaleProvider } from "@/lib/i18n";
import { activateLocale } from "@/test/render";
import { closeSessionSearch, SessionSearchDialog } from "./session-search-dialog";

function searchItem(overrides: Partial<SessionSearchItem> = {}): SessionSearchItem {
	return {
		id: "s1",
		title: "Deploy the cluster",
		ownerUserId: "u1",
		ownerName: "Ada",
		scheduleId: null,
		shared: false,
		state: "idle",
		waitingKind: null,
		unread: false,
		updatedAt: "2026-01-02T00:00:00.000Z",
		titleMatch: true,
		hitCount: 0,
		hits: [],
		...overrides,
	};
}

function searchPage(pages: SessionSearchPage[], cursor: string | undefined): SessionSearchPage {
	const index = cursor === undefined ? 0 : Number(cursor);
	return pages[index] ?? { items: [], nextCursor: null, contentSearch: true };
}

function requestParams(url: URL): Record<string, string> {
	return Object.fromEntries(url.searchParams.entries());
}

async function renderDialog(pages: SessionSearchPage[] = [{ items: [], nextCursor: null, contentSearch: true }]) {
	const requests: URL[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			requests.push(url);
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url.pathname === "/api/sessions/search")
				return json(searchPage(pages, url.searchParams.get("cursor") ?? undefined));
			return json({});
		}),
	);
	activateLocale("en");
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
	const rootRoute = createRootRoute();
	const sessionsRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/sessions",
		component: () => <SessionSearchDialog />,
	});
	const sessionRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/sessions/$sessionId",
		validateSearch: (search: Record<string, unknown>): { entry?: number } =>
			typeof search.entry === "string" ? { entry: Number(search.entry) } : {},
		component: () => <div data-testid="session-stub" />,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([sessionsRoute, sessionRoute]),
		history: createMemoryHistory({ initialEntries: ["/sessions"] }),
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

function openWithShortcut(): void {
	const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true });
	window.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(true);
}

function searchRequests(requests: URL[]): URL[] {
	return requests.filter((url) => url.pathname === "/api/sessions/search");
}

afterEach(() => {
	closeSessionSearch();
	vi.unstubAllGlobals();
});

describe("session search dialog", () => {
	test("Ctrl+K opens the dialog and focuses its input, and debounces one request with q and scope", async () => {
		const { requests } = await renderDialog();
		openWithShortcut();
		const input = await screen.findByTestId("session-search-input");
		await waitFor(() => expect(input).toHaveFocus());

		fireEvent.change(input, { target: { value: "dep" } });
		fireEvent.change(input, { target: { value: "deploy" } });
		expect(searchRequests(requests)).toHaveLength(0);
		await waitFor(() => expect(searchRequests(requests)).toHaveLength(1), { timeout: 1_500 });
		expect(requestParams(searchRequests(requests)[0] as URL)).toMatchObject({ q: "deploy", scope: "visible" });
	});

	test("groups hits under their session, highlights every keyword and shows the remaining count", async () => {
		const item = searchItem({
			titleMatch: true,
			hitCount: 5,
			hits: [
				{
					entryId: 11,
					sessionId: "s1",
					sessionTitle: "Deploy the cluster",
					role: "user",
					at: "2026-01-02T00:00:00.000Z",
					snippet: "deploy the cluster now",
				},
				{
					entryId: 12,
					sessionId: "s1-child",
					sessionTitle: "Child task",
					role: "assistant",
					at: "2026-01-02T00:01:00.000Z",
					snippet: "Cluster is healthy after the deploy",
				},
			],
		});
		await renderDialog([{ items: [item], nextCursor: null, contentSearch: true }]);
		openWithShortcut();
		fireEvent.change(await screen.findByTestId("session-search-input"), { target: { value: "deploy cluster" } });
		const dialog = await screen.findByTestId("session-search-dialog");
		await within(dialog).findByText("Ada");

		expect(within(dialog).getByText("Ada")).toBeInTheDocument();
		expect(within(dialog).getByText("Idle")).toBeInTheDocument();
		expect(within(dialog).getByText("You")).toBeInTheDocument();
		expect(within(dialog).getByText("Assistant")).toBeInTheDocument();
		expect(within(dialog).getByText(/Subagent: Child task/)).toBeInTheDocument();
		expect(within(dialog).getByText("3 more matches")).toBeInTheDocument();

		const marks = [...dialog.querySelectorAll("mark")].map((mark) => mark.textContent?.toLowerCase());
		expect(marks).toEqual(expect.arrayContaining(["deploy", "cluster"]));
	});

	test("Up/Down moves across session and hit rows, and Enter opens the hit with its entry param", async () => {
		const item = searchItem({
			hitCount: 1,
			hits: [
				{
					entryId: 42,
					sessionId: "s2",
					sessionTitle: "Deploy the cluster",
					role: "assistant",
					at: "2026-01-02T00:00:00.000Z",
					snippet: "deployed",
				},
			],
		});
		const { router } = await renderDialog([{ items: [item], nextCursor: null, contentSearch: true }]);
		openWithShortcut();
		const input = await screen.findByTestId("session-search-input");
		fireEvent.change(input, { target: { value: "deploy" } });
		await screen.findByText("Assistant");

		expect(screen.getByRole("option", { name: /^Deploy the cluster/ })).toHaveAttribute("data-active", "true");
		fireEvent.keyDown(input, { key: "ArrowDown" });
		expect(screen.getByRole("option", { name: /^Assistant/ })).toHaveAttribute("data-active", "true");
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(router.state.location.pathname).toBe("/sessions/s2"));
		expect(router.state.location.search).toEqual({ entry: 42 });
		expect(screen.queryByTestId("session-search-dialog")).not.toBeInTheDocument();
	});

	test("a session header opens the root session without an entry param", async () => {
		const item = searchItem({ titleMatch: true });
		const { router } = await renderDialog([{ items: [item], nextCursor: null, contentSearch: true }]);
		openWithShortcut();
		const input = await screen.findByTestId("session-search-input");
		fireEvent.change(input, { target: { value: "deploy" } });
		await screen.findByText("Ada");

		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(router.state.location.pathname).toBe("/sessions/s1"));
		expect(router.state.location.search).toEqual({});
	});

	test("an empty query shows the typing hint and no request", async () => {
		const { requests } = await renderDialog();
		openWithShortcut();
		expect(await screen.findByText("Type keywords separated by spaces")).toBeInTheDocument();
		expect(searchRequests(requests)).toHaveLength(0);
	});
});

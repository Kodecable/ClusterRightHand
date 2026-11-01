import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApprovalList, SessionListItem, SessionView } from "@/lib/api/types";
import { LocaleProvider } from "@/lib/i18n";
import { activateLocale } from "@/test/render";
import { sessionKeys } from "./api";
import { publishSessionListUpsert } from "./list-stream-bus";
import { SessionPage } from "./pages";

const APPROVALS: ApprovalList = {
	tasks: [],
	taskGroups: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [],
};

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: "s1",
		title: "Deploy the cluster",
		ownerUserId: "u1",
		parentSessionId: null,
		scheduleId: null,
		model: { provider: "faux", modelId: "faux-1" },
		status: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		rules: {
			scope: { type: "user", id: "u1" },
			preset: "auto_review",
			rules: [],
			default: "ask",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		relationship: "owner",
		capabilities: { view: true, chat: true, manageShares: true, configure: true },
		ownerUsername: "ops",
		state: "idle",
		waitingKind: null,
		waitingLevelId: null,
		quota: null,
		spentTokens: 0,
		...overrides,
	};
}

function item(overrides: Partial<SessionListItem> = {}): SessionListItem {
	return {
		id: "s1",
		title: "Deploy the cluster",
		ownerUserId: "u1",
		ownerName: "Ada",
		scheduleId: null,
		shared: false,
		state: "idle",
		waitingKind: null,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/** The page at `/sessions/s1`, with the list row the app would already have loaded. */
async function renderSessionPage({ session, treeRow }: { session: SessionView; treeRow?: SessionListItem }) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	if (treeRow !== undefined) {
		client.setQueryData(sessionKeys.listPage("mine", ""), {
			pages: [{ items: [treeRow], nextCursor: null }],
			pageParams: [null],
		});
	}
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			if (path === `/api/sessions/${session.id}`) return json({ session, shares: [] });
			if (path === `/api/sessions/${session.id}/children`) return json({ items: [], nextCursor: null });
			if (path === "/api/models") return json({ models: [] });
			if (path === "/api/approvals") return json(APPROVALS);
			if (path === "/api/nodes") return json({ nodes: [] });
			if (path === "/api/api-tokens") return json({ tokens: [] });
			return json({});
		}),
	);
	activateLocale("en");
	const rootRoute = createRootRoute();
	const sessionRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/sessions/$sessionId",
		component: SessionPage,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([sessionRoute]),
		history: createMemoryHistory({ initialEntries: [`/sessions/${session.id}`] }),
	});
	await router.load();
	return render(
		<LocaleProvider initialLocale="en">
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</LocaleProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SessionPage header", () => {
	test("shows the session's own state, never the tree's aggregate", async () => {
		await renderSessionPage({ session: sessionView() });
		await screen.findByTestId("session-page");
		expect(screen.getByText("Idle")).toBeInTheDocument();
		expect(screen.getByTestId("abort-session")).toBeDisabled();
		expect(screen.queryByTestId("waiting-reason")).not.toBeInTheDocument();
		expect(screen.queryByTestId("session-waits")).not.toBeInTheDocument();

		// The tree is awaiting a subagent's approval while this session itself is idle.
		act(() => {
			publishSessionListUpsert(item({ state: "awaiting", waitingKind: "approval" }));
		});

		await waitFor(() => expect(screen.getByTestId("session-waits")).toBeInTheDocument());
		expect(screen.getByText("Idle")).toBeInTheDocument();
		expect(screen.queryByTestId("waiting-reason")).not.toBeInTheDocument();
		// Stopping the root stops the subtree, so it stays available while any part runs.
		expect(screen.getByTestId("abort-session")).toBeEnabled();

		act(() => {
			publishSessionListUpsert(item({ state: "running", waitingKind: null }));
		});
		await waitFor(() => expect(screen.queryByTestId("session-waits")).not.toBeInTheDocument());
		expect(screen.getByTestId("abort-session")).toBeEnabled();
	});

	test("takes the root's aggregate from the loaded list on a fresh page", async () => {
		await renderSessionPage({ session: sessionView(), treeRow: item({ state: "running" }) });
		await screen.findByTestId("session-page");

		expect(screen.getByText("Idle")).toBeInTheDocument();
		expect(screen.getByTestId("abort-session")).toBeEnabled();
	});

	test("shows the preset by its product name", async () => {
		await renderSessionPage({ session: sessionView() });
		await screen.findByTestId("session-page");

		const header = screen.getByTestId("session-header");
		expect(header).toHaveTextContent("Preset: Auto Review");
		expect(header).not.toHaveTextContent("auto_review");
	});
});

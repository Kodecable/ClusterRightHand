import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { approvalKeys } from "@/features/approvals/api";
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
		refs: {},
		relationship: "owner",
		capabilities: { view: true, chat: true, manageShares: true, configure: true },
		ownerUsername: "ops",
		state: "idle",
		waitingKind: null,
		waitingLevelId: null,
		budgetRemaining: null,
		budgetUsedTokens: 0,
		usageTokens: 0,
		contextTokens: null,
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

/** The event stream subscription the page opens; open and events can be pushed from a test. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	readonly listeners = new Map<string, Set<(event: Event) => void>>();
	readonly url: string;

	constructor(url: string) {
		this.url = url;
		FakeEventSource.instances.push(this);
		// The connection opens on its own, as a browser's EventSource does.
		queueMicrotask(() => this.emit("open"));
	}

	addEventListener(name: string, listener: (event: Event) => void): void {
		let listeners = this.listeners.get(name);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(name, listeners);
		}
		listeners.add(listener);
	}

	close(): void {}

	emit(name: string, data?: unknown): void {
		for (const listener of this.listeners.get(name) ?? []) {
			listener(data === undefined ? new Event(name) : ({ data: JSON.stringify(data) } as MessageEvent));
		}
	}
}

/** The page's `/sessions/:id/events` stream, once the page has opened it. */
async function sessionEvents(sessionId: string): Promise<FakeEventSource> {
	const source = await waitFor(() => {
		const found = FakeEventSource.instances.find((instance) => instance.url.endsWith(`/sessions/${sessionId}/events`));
		if (found === undefined) throw new Error("the page opened no event stream");
		return found;
	});
	return source;
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
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			if (path === `/api/sessions/${session.id}`) return json({ session, shares: [] });
			if (path === `/api/sessions/${session.id}/children`) return json({ items: [], nextCursor: null });
			if (path === `/api/sessions/${session.id}/children/summary`)
				return json({ total: 0, states: { idle: 0, running: 0, awaiting: 0 } });
			if (path === "/api/models") return json({ models: [] });
			if (path === "/api/approvals") return json(APPROVALS);
			if (path === "/api/nodes") return json({ nodes: [] });
			if (path === "/api/node-groups") return json({ groups: [] });
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
	const result = render(
		<LocaleProvider initialLocale="en">
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</LocaleProvider>,
	);
	return { ...result, client };
}

afterEach(() => {
	FakeEventSource.instances = [];
	vi.unstubAllGlobals();
});

describe("SessionPage layout", () => {
	test("the header keeps the title and the share button only", async () => {
		await renderSessionPage({ session: sessionView() });
		await screen.findByTestId("session-page");
		const header = screen.getByTestId("session-header");
		expect(header.querySelector("[data-testid='session-title']")).toHaveValue("Deploy the cluster");
		expect(header.querySelector("[data-testid='share-session']")).not.toBeNull();
		// Model, rules, budget, state and stop moved out of the header.
		expect(header).not.toHaveTextContent("auto_review");
		expect(header).not.toHaveTextContent("Idle");
		expect(header.querySelector("[data-testid='abort-session']")).toBeNull();
		expect(header.querySelector("[data-testid='session-title']")).not.toBeNull();
	});

	test("the stop button follows the session's own run and, for a root, its tree's", async () => {
		await renderSessionPage({ session: sessionView() });
		await screen.findByTestId("session-page");
		expect(screen.queryByTestId("abort-session")).not.toBeInTheDocument();
		expect(screen.queryByTestId("session-waits")).not.toBeInTheDocument();

		// The tree is awaiting a subagent's approval while this session itself is idle: stopping the root stops
		// the subtree, so Stop is there.
		act(() => {
			publishSessionListUpsert(item({ state: "awaiting", waitingKind: "approval" }));
		});
		await waitFor(() => expect(screen.getByTestId("session-waits")).toBeInTheDocument());
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
		expect(screen.getByTestId("abort-session")).toBeEnabled();
	});

	test("shows the preset by its product name in the composer footer", async () => {
		await renderSessionPage({ session: sessionView() });
		await screen.findByTestId("session-page");

		const rules = screen.getByTestId("composer-rules");
		expect(rules).toHaveTextContent("Auto Review");
		expect(rules).not.toHaveTextContent("auto_review");
	});

	test("puts the waiting reason at the top and refreshes approvals as soon as the wait changes", async () => {
		const { client } = await renderSessionPage({
			session: sessionView({ state: "awaiting", waitingKind: "approval" }),
		});
		await screen.findByTestId("session-page");
		const banner = await screen.findByTestId("waiting-reason");
		const waits = screen.getByTestId("session-waits");
		expect(banner).toHaveTextContent("The session is waiting for an approval.");
		// The single-line banner sits under the header, before the waiting cards; the composer has no strip.
		const header = screen.getByTestId("session-header");
		expect(header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(banner.compareDocumentPosition(waits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const composer = document.querySelector<HTMLElement>('[data-slot="composer"]');
		expect(composer).not.toBeNull();
		expect(within(composer as HTMLElement).queryByTestId("waiting-reason")).toBeNull();

		const invalidate = vi.spyOn(client, "invalidateQueries");
		act(() => {
			client.setQueryData(sessionKeys.detail("s1"), sessionView({ state: "awaiting", waitingKind: "authorization" }));
		});
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: approvalKeys.list() }));
		expect(screen.getByTestId("waiting-reason")).toHaveTextContent("The session is waiting for a signature.");
	});

	test("refreshes approvals when a live tool reports that it waits", async () => {
		const { client } = await renderSessionPage({
			session: sessionView({ state: "awaiting", waitingKind: "approval" }),
		});
		await screen.findByTestId("session-page");
		await screen.findByTestId("waiting-reason");
		const source = await sessionEvents("s1");
		const invalidate = vi.spyOn(client, "invalidateQueries");

		act(() => {
			source.emit("events", [
				{
					type: "tool_execution_update",
					toolCallId: "call-1",
					toolName: "exec",
					details: { state: "awaiting_authorization", authorization_url: "/tasks/t1" },
				},
			]);
		});

		await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: approvalKeys.list() }));
	});

	test("shows no Working banner while the session merely runs", async () => {
		await renderSessionPage({ session: sessionView() });
		await screen.findByTestId("session-page");
		const source = await sessionEvents("s1");
		act(() => {
			source.emit("events", [{ type: "run_start", inputs: [] }]);
		});
		expect(screen.queryByText("Working…")).not.toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});

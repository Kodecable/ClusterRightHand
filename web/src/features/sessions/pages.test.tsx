import type { ApprovalList, SessionListItem, SessionView, TaskView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, test, vi } from "vitest";
import { approvalKeys } from "@/features/approvals/api";
import { LocaleProvider } from "@/lib/i18n";
import { activateLocale } from "@/test/render";
import { sessionKeys } from "./api";
import { publishSessionListUpsert } from "./list-stream-bus";
import { SessionPage } from "./pages";
import type { EntryRecord, SessionEntriesPage, SessionEvent } from "./session-events";

// jsdom has no layout: render the virtualized rows directly. React 19 passes the
// Virtualizer's ref as a prop, so the transcript's scrollToIndex handle exists too.
vi.mock("virtua", async () => {
	const { createElement } = await import("react");
	return {
		Virtualizer: (props: { data: unknown[]; children: (item: unknown) => ReactNode; ref?: { current: unknown } }) => {
			if (props.ref !== undefined && props.ref !== null) props.ref.current = { scrollToIndex: () => {} };
			return createElement(
				"div",
				null,
				props.data.map((row) => props.children(row)),
			);
		},
	};
});

const APPROVALS: ApprovalList = {
	tasks: [],
	taskGroups: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [],
};

/** One task waiting for approval in the session tree. */
function approvalTask(overrides: Partial<TaskView> = {}): TaskView {
	return {
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: "echo first",
		operation: { method: "exec", target: "echo first" },
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		state: "awaiting_approval",
		privileged: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		approval: null,
		rootSessionId: "s1",
		...overrides,
	} as TaskView;
}

/** The approvals list a test answers; every other category stays empty. */
function waitingApprovals(tasks: TaskView[], quotas: ApprovalList["quotas"] = []): ApprovalList {
	return { tasks, taskGroups: [], authorizations: { tasks: [], taskGroups: [] }, quotas };
}

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
			rulePreset: "auto_review",
			rules: [],
			default: "require-approval",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		refs: {},
		relationship: "owner",
		capabilities: { view: true, chat: true, manageShares: true, createShares: true, configure: true },
		ownerUsername: "ops",
		state: "idle",
		waitingKind: null,
		waitingLevelId: null,
		budgetRemaining: null,
		budgetUsedTokens: 0,
		usageTokens: 0,
		contextTokens: null,
		stats: {
			turns: 0,
			steps: 0,
			ttftMs: 0,
			ttftSteps: 0,
			decodeMs: 0,
			decodeTokens: 0,
			promptTokens: 0,
			cacheReadTokens: 0,
		},
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
		unread: false,
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
async function renderSessionPage({
	session,
	treeRow,
	eventsStatus,
	entry,
	olderPage,
	approvals,
}: {
	session: SessionView;
	treeRow?: SessionListItem;
	/** The status the failed event stream's HEAD probe sees; defaults to 200 like the real stream route. */
	eventsStatus?: number;
	/** The `?entry=` search param a search hit adds. */
	entry?: number;
	/** The page `GET /sessions/:id/entries?before=` answers; defaults to an empty, finished history. */
	olderPage?: (before: string) => SessionEntriesPage;
	/** The approvals list the test answers, read on every poll/refetch so a decision can settle it. */
	approvals?: () => ApprovalList;
}) {
	const requests: URL[] = [];
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
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			requests.push(url);
			const json = (body: unknown) =>
				new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
			if (init?.method === "HEAD") return new Response(null, { status: eventsStatus ?? 200 });
			if (path === `/api/sessions/${session.id}/entries`) {
				const before = url.searchParams.get("before") ?? "";
				return json(olderPage?.(before) ?? { entries: [], historyCursor: null });
			}
			if (path === `/api/sessions/${session.id}`) return json({ session, shares: [] });
			if (path === `/api/sessions/${session.id}/children`) return json({ items: [], nextCursor: null });
			if (path === `/api/sessions/${session.id}/children/summary`)
				return json({ total: 0, states: { idle: 0, running: 0, awaiting: 0 } });
			if (path === "/api/models") return json({ models: [] });
			if (path === "/api/approvals") return json(approvals?.() ?? APPROVALS);
			if (path === "/api/nodes") return json({ nodes: [] });
			if (path === "/api/node-groups") return json({ groups: [] });
			if (path === "/api/api-tokens") return json({ tokens: [] });
			if (path === "/api/directory") return json({ users: [], userGroups: [] });
			return json({});
		}),
	);
	activateLocale("en");
	const rootRoute = createRootRoute();
	const sessionRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/sessions/$sessionId",
		validateSearch: (search: Record<string, unknown>): { entry?: number } =>
			typeof search.entry === "string" ? { entry: Number(search.entry) } : {},
		component: SessionPage,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([sessionRoute]),
		history: createMemoryHistory({
			initialEntries: [entry === undefined ? `/sessions/${session.id}` : `/sessions/${session.id}?entry=${entry}`],
		}),
	});
	await router.load();
	const result = render(
		<LocaleProvider initialLocale="en">
			<QueryClientProvider client={client}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</LocaleProvider>,
	);
	return { ...result, client, router, requests };
}

function userEntry(id: string, text: string): EntryRecord {
	return {
		id,
		kind: "pi.user",
		model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1_767_225_600_000 }],
	};
}

function assistantEntry(id: string, text: string): EntryRecord {
	return {
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text }], timestamp: 1_767_225_600_000 }],
	};
}

function snapshotEvent(entries: EntryRecord[], historyCursor: string | null): SessionEvent[] {
	return [{ type: "snapshot", snapshot: { entries, tools: [], inbox: [], historyCursor } }];
}

async function emitSnapshot(source: FakeEventSource, entries: EntryRecord[], historyCursor: string | null) {
	await act(async () => {
		source.emit("events", snapshotEvent(entries, historyCursor));
	});
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

	test("the owner's open session marks its tree read and clears the row optimistically", async () => {
		const { client } = await renderSessionPage({ session: sessionView(), treeRow: item({ unread: true }) });
		await screen.findByTestId("session-page");
		await waitFor(() => {
			expect(
				vi
					.mocked(fetch)
					.mock.calls.some(
						([input, init]) =>
							String(input).endsWith("/api/sessions/s1/read") && (init as RequestInit | undefined)?.method === "POST",
					),
			).toBe(true);
		});
		const data = client.getQueryData<{ pages: { items: SessionListItem[] }[] }>(sessionKeys.listPage("mine", ""));
		expect(data?.pages[0]?.items[0]?.unread).toBe(false);
	});

	test("a shared viewer never marks a session read", async () => {
		await renderSessionPage({
			session: sessionView({
				relationship: "shared",
				capabilities: { view: true, chat: false, manageShares: false, createShares: false, configure: false },
			}),
		});
		await screen.findByTestId("session-page");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			vi
				.mocked(fetch)
				.mock.calls.some(
					([input, init]) => String(input).endsWith("/read") && (init as RequestInit | undefined)?.method === "POST",
				),
		).toBe(false);
	});

	test("a session with no title shows the default name", async () => {
		await renderSessionPage({ session: sessionView({ title: null }) });
		await screen.findByTestId("session-page");
		const input = screen.getByTestId("session-title");
		expect(input).toHaveValue("");
		expect(input).toHaveAttribute("placeholder", "New Session");
	});

	test("clearing the title sends an empty title", async () => {
		await renderSessionPage({ session: sessionView() });
		await screen.findByTestId("session-page");

		// A blank edit is sent as an empty title (the server turns it into null and stops generation).
		fireEvent.change(screen.getByTestId("session-title"), { target: { value: "   " } });
		fireEvent.blur(screen.getByTestId("session-title"));
		await waitFor(() => {
			expect(
				vi
					.mocked(fetch)
					.mock.calls.some(
						([inputPath, init]) =>
							String(inputPath).endsWith("/api/sessions/s1") && (init as RequestInit | undefined)?.method === "PATCH",
					),
			).toBe(true);
		});
		const patch = vi
			.mocked(fetch)
			.mock.calls.find(
				([inputPath, init]) =>
					String(inputPath).endsWith("/api/sessions/s1") && (init as RequestInit | undefined)?.method === "PATCH",
			);
		expect(JSON.parse(String((patch?.[1] as RequestInit | undefined)?.body))).toEqual({ title: "" });
	});

	test("the stop button follows the session's own run and, for a root, its tree's", async () => {
		await renderSessionPage({ session: sessionView() });
		await screen.findByTestId("session-page");
		expect(screen.queryByTestId("abort-session")).not.toBeInTheDocument();
		// Nothing waits for this viewer, so the composer keeps its place.
		expect(screen.getByTestId("composer-input")).toBeInTheDocument();
		expect(screen.queryByTestId("session-decisions")).not.toBeInTheDocument();

		// The tree is awaiting a subagent's approval while this session itself is idle: stopping the root stops
		// the subtree, so Stop is there. There is no decision for this viewer, so the composer stays.
		act(() => {
			publishSessionListUpsert(item({ state: "awaiting", waitingKind: "approval" }));
		});
		await waitFor(() => expect(screen.getByTestId("abort-session")).toBeEnabled());
		expect(screen.getByTestId("composer-input")).toBeInTheDocument();
		expect(screen.queryByTestId("session-decisions")).not.toBeInTheDocument();

		act(() => {
			publishSessionListUpsert(item({ state: "running", waitingKind: null }));
		});
		await waitFor(() => expect(screen.getByTestId("abort-session")).toBeEnabled());
		expect(screen.getByTestId("composer-input")).toBeInTheDocument();
	});

	test("takes the root's aggregate from the loaded list on a fresh page", async () => {
		await renderSessionPage({ session: sessionView(), treeRow: item({ state: "running" }) });
		await screen.findByTestId("session-page");
		expect(screen.getByTestId("abort-session")).toBeEnabled();
	});

	test("shows the rule preset by its product name in the composer footer", async () => {
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
		expect(banner).toHaveTextContent("The session is waiting for an approval.");
		// The single-line banner sits under the header, before the composer; the composer has no strip.
		const header = screen.getByTestId("session-header");
		expect(header.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const composer = document.querySelector<HTMLElement>('[data-slot="composer"]');
		expect(composer).not.toBeNull();
		expect(banner.compareDocumentPosition(composer as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(within(composer as HTMLElement).queryByTestId("waiting-reason")).toBeNull();
		// Nothing is waiting for this viewer, so the dock is absent and the composer stays.
		expect(screen.queryByTestId("session-decisions")).not.toBeInTheDocument();

		const invalidate = vi.spyOn(client, "invalidateQueries");
		act(() => {
			client.setQueryData(sessionKeys.detail("s1"), sessionView({ state: "awaiting", waitingKind: "authorization" }));
		});
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: approvalKeys.list() }));
		expect(screen.getByTestId("waiting-reason")).toHaveTextContent("The session is waiting for a signature.");
	});

	test("the dock replaces the composer and shows only the first decision of the tree", async () => {
		const quota = {
			sessionId: "s1",
			levelId: "s1",
			title: "Deploy the cluster",
			since: "2026-01-01T00:00:00Z",
			budgetRemaining: 0,
			budgetUsedTokens: 100,
		};
		await renderSessionPage({
			session: sessionView({ state: "awaiting", waitingKind: "quota" }),
			approvals: () =>
				waitingApprovals(
					[
						approvalTask({ id: "task-later", summary: "echo later", createdAt: "2026-01-02T00:00:00.000Z" }),
						approvalTask(),
					],
					[quota],
				),
		});
		await screen.findByTestId("session-page");
		const dock = await screen.findByTestId("session-decisions");
		// The quota comes first, one item at a time; the approvals wait behind it.
		expect(within(dock).getByRole("region", { name: "Token quota used up" })).toBeInTheDocument();
		expect(within(dock).getByText("1 of 3")).toBeInTheDocument();
		expect(within(dock).queryByText("echo first")).not.toBeInTheDocument();
		expect(screen.queryByTestId("composer-input")).not.toBeInTheDocument();
		// The dock has no Stop button of its own; the composer carries the only one.
		expect(within(dock).queryByTestId("abort-session")).not.toBeInTheDocument();
	});

	test("shows only the first decision of the tree while more wait behind it", async () => {
		await renderSessionPage({
			session: sessionView({ state: "awaiting", waitingKind: "approval" }),
			approvals: () =>
				waitingApprovals([
					approvalTask(),
					approvalTask({ id: "task-2", summary: "echo second", createdAt: "2026-01-02T00:00:00.000Z" }),
				]),
		});
		await screen.findByTestId("session-page");
		const dock = await screen.findByTestId("session-decisions");
		expect(within(dock).getByTestId("decision-operation")).toHaveTextContent("echo first");
		expect(within(dock).getByText("1 of 2")).toBeInTheDocument();
		expect(within(dock).queryByText("echo second")).not.toBeInTheDocument();
		expect(screen.queryByTestId("composer-input")).not.toBeInTheDocument();
	});

	test("another session's decisions stay out of this session's dock", async () => {
		await renderSessionPage({
			session: sessionView({ state: "awaiting", waitingKind: "approval" }),
			approvals: () => waitingApprovals([approvalTask({ rootSessionId: "s2" })]),
		});
		await screen.findByTestId("session-page");
		await screen.findByTestId("waiting-reason");
		expect(screen.queryByTestId("session-decisions")).not.toBeInTheDocument();
		expect(screen.getByTestId("composer-input")).toBeInTheDocument();
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

	test("a terminal stream error replaces the stale page with its error state", async () => {
		await renderSessionPage({ session: sessionView(), eventsStatus: 404 });
		await screen.findByTestId("session-page");
		const source = await sessionEvents("s1");

		act(() => {
			source.emit("error");
		});

		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("HTTP 404"));
		expect(screen.queryByTestId("session-page")).not.toBeInTheDocument();
	});
});

describe("jump to a searched entry", () => {
	test("an entry in the loaded snapshot is marked and its param is dropped", async () => {
		const { router } = await renderSessionPage({ session: sessionView(), entry: 2 });
		await screen.findByTestId("session-page");
		const source = await sessionEvents("s1");
		await emitSnapshot(source, [userEntry("1", "hello"), assistantEntry("2", "the answer")], null);

		const row = await waitFor(
			() => {
				const found = document.querySelector<HTMLElement>('[data-entry-id="2"][data-highlighted="true"]');
				if (found === null) throw new Error("the entry row is not highlighted yet");
				return found;
			},
			{ timeout: 3_000 },
		);
		expect(row).toHaveAttribute("data-message-id", "2/0");
		await waitFor(() => expect(router.state.location.search).not.toHaveProperty("entry"));
	});

	test("loads older history pages until the entry appears", async () => {
		const { router, requests } = await renderSessionPage({
			session: sessionView(),
			entry: 1,
			olderPage: () => ({ entries: [userEntry("1", "the oldest"), userEntry("2", "older")], historyCursor: null }),
		});
		await screen.findByTestId("session-page");
		const source = await sessionEvents("s1");
		await emitSnapshot(source, [userEntry("10", "recent"), userEntry("11", "newest")], "h1");

		await waitFor(
			() => {
				const found = document.querySelector<HTMLElement>('[data-entry-id="1"][data-highlighted="true"]');
				if (found === null) throw new Error("the older entry row is not highlighted yet");
				return found;
			},
			{ timeout: 5_000 },
		);
		expect(
			requests.some((url) => url.pathname === "/api/sessions/s1/entries" && url.searchParams.get("before") === "h1"),
		).toBe(true);
		await waitFor(() => expect(router.state.location.search).not.toHaveProperty("entry"));
	});

	test("gives up after the page cap with a toast", async () => {
		const error = vi.spyOn(toast, "error").mockImplementation(() => "");
		let pages = 0;
		const { router, requests } = await renderSessionPage({
			session: sessionView(),
			entry: 999,
			olderPage: () => {
				pages += 1;
				return { entries: [userEntry(`x${pages}`, `older ${pages}`)], historyCursor: `h${pages}` };
			},
		});
		await screen.findByTestId("session-page");
		const source = await sessionEvents("s1");
		await emitSnapshot(source, [userEntry("100", "recent")], "h0");

		await waitFor(() => expect(error).toHaveBeenCalledWith("Couldn't find that message in this session."), {
			timeout: 10_000,
		});
		expect(requests.filter((url) => url.pathname === "/api/sessions/s1/entries")).toHaveLength(20);
		await waitFor(() => expect(router.state.location.search).not.toHaveProperty("entry"));
	});
});

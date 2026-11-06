import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { approvalKeys } from "@/features/approvals/api";
import { taskKeys } from "@/features/tasks/api";
import type { ApprovalList, SessionListItem, SessionPatch, SessionView } from "@/lib/api/types";
import { sessionKeys, useAbortSession, usePatchSession, useSessionTreeSync } from "./api";
import { publishSessionListUpsert } from "./list-stream-bus";

const APPROVALS: ApprovalList = {
	tasks: [],
	taskGroups: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [],
};

function detail(overrides: Partial<SessionView> = {}): SessionView {
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
		rules: null,
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

function Harness({ sessionId, rootId }: { sessionId: string; rootId: string }) {
	const tree = useSessionTreeSync(sessionId, rootId);
	return <span data-testid="tree-state">{tree?.state ?? "unknown"}</span>;
}

function setup({
	sessionId = "s1",
	rootId = "s1",
	seed,
}: {
	sessionId?: string;
	rootId?: string;
	seed?: (client: QueryClient) => void;
} = {}) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	seed?.(client);
	const view = render(
		<QueryClientProvider client={client}>
			<Harness sessionId={sessionId} rootId={rootId} />
		</QueryClientProvider>,
	);
	return { client, ...view };
}

function mockFetch(): string[] {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			calls.push(path);
			const body = path.endsWith("/abort") ? { ok: true } : { session: detail() };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const treeState = () => screen.getByTestId("tree-state").textContent;

describe("useSessionTreeSync", () => {
	test("never writes the tree's aggregate over the session's own state", () => {
		const { client } = setup();
		client.setQueryData(sessionKeys.detail("s1"), detail({ state: "idle" }));

		act(() => {
			publishSessionListUpsert(item({ state: "awaiting", waitingKind: "approval" }));
		});

		const cached = client.getQueryData<SessionView>(sessionKeys.detail("s1"));
		expect(cached?.state).toBe("idle");
		expect(cached?.waitingKind).toBeNull();
		// The detail is refetched instead, so the page learns the session's own state.
		expect(client.getQueryState(sessionKeys.detail("s1"))?.isInvalidated).toBe(true);
		// The aggregate is still handed to the consumers that concern the whole tree.
		expect(treeState()).toBe("awaiting");
	});

	test("refreshes the pending decisions when the tree starts or stops waiting", () => {
		const { client } = setup();
		client.setQueryData(approvalKeys.list(), APPROVALS);

		act(() => {
			publishSessionListUpsert(item({ state: "awaiting", waitingKind: "approval" }));
		});
		expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(true);

		// Away from awaiting: the cards of a decision made elsewhere must go too.
		client.setQueryData(approvalKeys.list(), APPROVALS);
		act(() => {
			publishSessionListUpsert(item({ state: "running", waitingKind: null }));
		});
		expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(true);
	});

	test("does not refresh the pending decisions when only the update time changes", () => {
		const { client } = setup();
		client.setQueryData(approvalKeys.list(), APPROVALS);

		act(() => {
			publishSessionListUpsert(item({ state: "running", updatedAt: "2026-01-01T00:01:00.000Z" }));
		});

		expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(false);
	});

	test("takes the aggregate from the loaded session list before any upsert", () => {
		setup({
			sessionId: "child-1",
			rootId: "root-1",
			seed: (client) =>
				client.setQueryData(sessionKeys.listPage("mine", ""), {
					pages: [{ items: [item({ id: "root-1", state: "running" })], nextCursor: null }],
					pageParams: [null],
				}),
		});

		expect(treeState()).toBe("running");
	});
});

function MutationHarness({ action }: { action: () => void }) {
	return (
		<button type="button" onClick={action}>
			Go
		</button>
	);
}

function PatchSessionHarness({ patch }: { patch: SessionPatch }) {
	const mutation = usePatchSession("s1");
	return <MutationHarness action={() => mutation.mutate(patch)} />;
}

function AbortSessionHarness() {
	const abort = useAbortSession("s1");
	return <MutationHarness action={() => abort.mutate()} />;
}

describe("session mutations", () => {
	test("a rule preset change refreshes the tasks the server re-evaluated", async () => {
		const calls = mockFetch();
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		client.setQueryData(approvalKeys.list(), APPROVALS);
		client.setQueryData(taskKeys.detail("task-1"), { id: "task-1" });

		render(
			<QueryClientProvider client={client}>
				<PatchSessionHarness patch={{ rulePreset: "yolo" }} />
			</QueryClientProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Go" }));
		await waitFor(() => expect(calls).toContain("/api/sessions/s1"));
		await waitFor(() => {
			expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(true);
			expect(client.getQueryState(taskKeys.detail("task-1"))?.isInvalidated).toBe(true);
		});
	});

	test("a title change leaves the waiting tasks alone", async () => {
		const calls = mockFetch();
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		client.setQueryData(approvalKeys.list(), APPROVALS);

		render(
			<QueryClientProvider client={client}>
				<PatchSessionHarness patch={{ title: "Renamed" }} />
			</QueryClientProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Go" }));
		await waitFor(() => expect(calls).toContain("/api/sessions/s1"));
		expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(false);
	});

	test("stopping a session refreshes the waits and tasks it ends", async () => {
		const calls = mockFetch();
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		client.setQueryData(approvalKeys.list(), APPROVALS);
		client.setQueryData(taskKeys.taskGroup("group-1"), { id: "group-1" });

		render(
			<QueryClientProvider client={client}>
				<AbortSessionHarness />
			</QueryClientProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Go" }));
		await waitFor(() => expect(calls).toContain("/api/sessions/s1/abort"));
		await waitFor(() => {
			expect(client.getQueryState(approvalKeys.list())?.isInvalidated).toBe(true);
			expect(client.getQueryState(taskKeys.taskGroup("group-1"))?.isInvalidated).toBe(true);
		});
	});
});

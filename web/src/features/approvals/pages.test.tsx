import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ApprovalList, Evaluation, TaskGroupView, TaskView } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { ApprovalsPage } from "./pages";

const evaluation: Evaluation = {
	result: "require-approval",
	levels: [
		{
			scope: { type: "user", id: "u1" },
			own: "require-approval",
			rule: 0,
			matched: { action: "require-approval", method: "exec", prefix: "systemctl " },
			effective: "require-approval",
		},
	],
};

const task = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: "systemctl restart nginx",
		operation: { method: "exec", target: "systemctl restart nginx" },
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: null,
		state: "awaiting_approval",
		exitCode: null,
		signal: null,
		privileged: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		approval: { evaluation },
		...overrides,
	}) as TaskView;

const group = {
	id: "group-1",
	state: "awaiting_approval",
	kind: "exec",
	summary: "restart",
	nodeIds: ["node-1"],
	targets: ["node-1"],
	parallel: 1,
	failFast: false,
	outputMode: "status",
	privileged: false,
	skipped: [],
	tasks: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	finishedAt: null,
	approval: { nodes: [{ nodeId: "node-1", evaluation }] },
} as unknown as TaskGroupView;

const data: ApprovalList = {
	tasks: [task()],
	taskGroups: [group],
	authorizations: {
		tasks: [task({ id: "auth-task", state: "awaiting_authorization", summary: "sign me" })],
		taskGroups: [],
	},
	quotas: [
		{ sessionId: "s1", levelId: "root", title: "Nightly check", since: "2026-01-01T00:00:00Z", quota: 0, used: 100 },
	],
};

function mockApi(): { calls: { url: string; body: unknown }[] } {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
			calls.push({ url, body });
			let payload: unknown = { ok: true };
			if (url.startsWith("/api/approvals")) payload = data;
			else if (url.startsWith("/api/nodes")) payload = { nodes: [] };
			else if (url.startsWith("/api/api-tokens")) payload = { tokens: [] };
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { calls };
}

async function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderWithRouter(
		<QueryClientProvider client={client}>
			<ApprovalsPage />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ApprovalsPage", () => {
	test("shows every waiting section", async () => {
		mockApi();
		await renderPage();
		await waitFor(() => expect(screen.getByTestId("approvals-page")).toBeInTheDocument());
		expect(screen.getByText("Task approvals")).toBeInTheDocument();
		expect(screen.getByText("Task-group approvals")).toBeInTheDocument();
		expect(screen.getByTestId("signature-section")).toBeInTheDocument();
		expect(screen.getAllByText("Token quota used up").length).toBeGreaterThan(0);
		expect(screen.getByText("Nightly check")).toBeInTheDocument();
	});

	test("a decision goes through the approval endpoint", async () => {
		const { calls } = mockApi();
		await renderPage();
		const card = await screen.findByRole("region", { name: /Task task-1/ });
		fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
		await waitFor(() => expect(calls.some((call) => call.url === "/api/tasks/task-1/approval")).toBe(true));
		const decision = calls.find((call) => call.url === "/api/tasks/task-1/approval");
		expect(decision?.body).toEqual({ decision: "approve" });
	});

	test("an empty approvals list says nothing is waiting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					JSON.stringify({ tasks: [], taskGroups: [], authorizations: { tasks: [], taskGroups: [] }, quotas: [] }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}),
		);
		await renderPage();
		expect(await screen.findByText("Nothing is waiting for you")).toBeInTheDocument();
	});
});

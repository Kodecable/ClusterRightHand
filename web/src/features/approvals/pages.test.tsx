import type { ApprovalList, PendingAuthorization, TaskGroupView, TaskView } from "@crh/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ApprovalsPage, ApprovalTaskGroupPage, ApprovalTaskPage } from "./pages";

const OPERATION = "systemctl restart nginx";

const task = (overrides: Partial<TaskView> = {}): TaskView =>
	({
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: OPERATION,
		operation: { method: "exec", target: OPERATION },
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		state: "awaiting_approval",
		exitCode: null,
		signal: null,
		privileged: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		approval: null,
		rootSessionId: null,
		...overrides,
	}) as TaskView;

const group = (overrides: Partial<TaskGroupView> = {}): TaskGroupView =>
	({
		id: "group-1",
		state: "awaiting_approval",
		kind: "exec",
		summary: "restart all",
		targets: ["node-1", "node-2"],
		refs: { "node-1": { kind: "node", name: "worker-01" }, "node-2": { kind: "node", name: "worker-02" } },
		nodeIds: ["node-1", "node-2"],
		parallel: 1,
		failFast: false,
		outputMode: "status",
		privileged: false,
		skipped: [],
		tasks: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		operation: { method: "exec", target: OPERATION },
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		rootSessionId: null,
		...overrides,
	}) as TaskGroupView;

const emptyApprovals = (): ApprovalList => ({
	tasks: [],
	taskGroups: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [],
});

const approvals = (): ApprovalList => ({
	tasks: [task()],
	taskGroups: [group()],
	authorizations: {
		tasks: [task({ id: "auth-task", summary: "sign me", operation: null, state: "awaiting_authorization" })],
		taskGroups: [],
	},
	quotas: [
		{
			sessionId: "s1",
			levelId: "root",
			title: "Nightly check",
			since: "2026-01-01T00:00:00Z",
			budgetRemaining: 0,
			budgetUsedTokens: 100,
		},
	],
});

const pending = (): PendingAuthorization => ({
	id: "a".repeat(64),
	payload: "o2dub2RlcwFhZ3JvdXA6d2Vi",
	challenge: "challenge-b64url",
	deadline: "2026-10-31T12:00:00.000Z",
	taskIds: ["task-1"],
	attempt: 2,
	passkeys: [],
	localRequested: false,
	lastRejection: null,
	tried: [],
	decoded: {
		nodes: ["node-1"],
		command: { method: "exec", match: "exact", target: OPERATION, specSha256: "b".repeat(64) },
		issuedAt: "2026-10-30T12:00:00.000Z",
		deadline: "2026-10-31T12:00:00.000Z",
		taskIds: ["task-1"],
		attempt: 2,
		note: "",
	},
});

interface MockState {
	approvals: ApprovalList;
	task?: TaskView;
	taskGroup?: TaskGroupView;
	pending?: PendingAuthorization | null;
	calls: { url: string; body: unknown }[];
}

/** A fake API with mutable task/pending state, so an invalidation sees the settled value. */
function mockApi(overrides: Partial<MockState> = {}): MockState {
	const state: MockState = { approvals: emptyApprovals(), calls: [], ...overrides };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname;
			const method = init?.method ?? "GET";
			const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
			state.calls.push({ url: path, body });
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (path === "/api/approvals") return json(state.approvals);
			if (path === "/api/nodes")
				return json({
					nodes: [
						{ id: "node-1", name: "worker-01" },
						{ id: "node-2", name: "worker-02" },
					],
				});
			if (path === "/api/node-groups") return json({ groups: [] });
			if (path === "/api/api-tokens") return json({ tokens: [] });
			if (path === "/api/directory")
				return json({ users: [{ id: "u1", username: "ada", displayName: "Ada" }], userGroups: [] });
			if (state.task !== undefined && path === `/api/tasks/${state.task.id}`) return json({ task: state.task });
			if (state.task !== undefined && path === `/api/tasks/${state.task.id}/authorization`)
				return json({ authorization: state.pending ?? null });
			if (state.taskGroup !== undefined && path === `/api/task-groups/${state.taskGroup.id}`)
				return json({ taskGroup: state.taskGroup });
			if (state.taskGroup !== undefined && path === `/api/task-groups/${state.taskGroup.id}/authorization`)
				return json({ taskGroup: { authorization: state.pending ?? null, tasks: [] } });
			if (method === "POST" && path === `/api/tasks/${state.task?.id}/approval`) {
				if (state.task !== undefined) state.task = { ...state.task, state: "exited" };
				state.approvals = emptyApprovals();
				return json({ ok: true });
			}
			if (method === "POST" && path.endsWith("/authorization/reject")) {
				if (state.task !== undefined) state.task = { ...state.task, state: "rejected" };
				state.approvals = emptyApprovals();
				return json({ ok: true });
			}
			return json({ ok: true });
		}),
	);
	return state;
}

async function renderPage(ui: React.ReactElement, path?: string, entry?: string) {
	return renderWithRouter(ui, "en", path === undefined ? {} : { path, initialEntries: [entry ?? path] });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ApprovalsPage", () => {
	test("shows one table of everything waiting with names, actors, times and links", async () => {
		mockApi({ approvals: approvals() });
		await renderPage(<ApprovalsPage />);
		await screen.findByTestId("approvals-page");
		const table = await screen.findByRole("table", { name: "Waiting for you" });

		expect(within(table).getAllByText("Approval")).toHaveLength(2);
		expect(within(table).getByText("Signature")).toBeInTheDocument();
		expect(within(table).getByText("Quota")).toBeInTheDocument();
		expect(within(table).getByText(OPERATION)).toBeInTheDocument();
		expect(within(table).getByText("restart all")).toBeInTheDocument();
		expect(within(table).getByText("sign me")).toBeInTheDocument();
		expect(within(table).getByText("Nightly check")).toBeInTheDocument();
		// Group nodes are names (NodeTargetList), never the stored UUIDs.
		expect(within(table).getAllByText("worker-01").length).toBeGreaterThan(0);
		expect(within(table).getAllByText("worker-02").length).toBeGreaterThan(0);
		expect(within(table).queryByText("node-2")).not.toBeInTheDocument();
		// The asked-by user links to the user page.
		for (const link of within(table).getAllByRole("link", { name: "Ada" })) {
			expect(link).toHaveAttribute("href", "/users/u1");
		}
		expect(within(table).getAllByRole("time").length).toBe(4);

		// Every row is a link to its decision page, and a quota row opens the session.
		expect(within(table).getByRole("link", { name: OPERATION })).toHaveAttribute("href", "/approvals/tasks/task-1");
		expect(within(table).getByRole("link", { name: "restart all" })).toHaveAttribute(
			"href",
			"/approvals/task-groups/group-1",
		);
		expect(within(table).getByRole("link", { name: "sign me" })).toHaveAttribute("href", "/approvals/tasks/auth-task");
		expect(within(table).getByRole("link", { name: "Nightly check" })).toHaveAttribute("href", "/sessions/s1");
	});

	test("an empty approvals list says nothing is waiting", async () => {
		mockApi();
		await renderPage(<ApprovalsPage />);
		expect(await screen.findByText("Nothing is waiting for you")).toBeInTheDocument();
	});
});

describe("ApprovalTaskPage", () => {
	test("shows the approval decision and settles after a decision", async () => {
		const state = mockApi({ task: task(), approvals: approvals() });
		await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		const region = await screen.findByRole("region", { name: "Your approval is needed" });
		fireEvent.click(within(region).getByRole("button", { name: "Approve" }));
		await waitFor(() => expect(state.calls.some((call) => call.url === "/api/tasks/task-1/approval")).toBe(true));
		const decision = state.calls.find((call) => call.url === "/api/tasks/task-1/approval");
		expect(decision?.body).toEqual({ decision: "approve" });
		expect(await screen.findByText("Already settled")).toBeInTheDocument();
	});

	test("a task waiting for its signature shows the signature decision and rejects through the new endpoint", async () => {
		const state = mockApi({
			task: task({ state: "awaiting_authorization" }),
			pending: pending(),
			approvals: emptyApprovals(),
		});
		await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		const region = await screen.findByRole("region", { name: "Sign to approve" });
		expect(within(region).getByRole("tab", { name: "crha grant" })).toHaveAttribute("aria-selected", "true");
		fireEvent.click(within(region).getByRole("tab", { name: "Reject" }));
		fireEvent.change(within(region).getByLabelText("Reason (optional)"), {
			target: { value: "  not signing  " },
		});
		fireEvent.click(within(region).getByRole("button", { name: "Reject" }));
		await waitFor(() =>
			expect(state.calls.some((call) => call.url === "/api/tasks/task-1/authorization/reject")).toBe(true),
		);
		const rejection = state.calls.find((call) => call.url === "/api/tasks/task-1/authorization/reject");
		expect(rejection?.body).toEqual({ reason: "not signing" });
	});

	test("a settled task shows Already settled", async () => {
		mockApi({ task: task({ state: "exited" }) });
		await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		expect(await screen.findByText("Already settled")).toBeInTheDocument();
	});
});

describe("ApprovalTaskGroupPage", () => {
	test("a task group waiting for its signature shows the same signature decision", async () => {
		mockApi({
			taskGroup: group({ state: "awaiting_authorization" }),
			pending: pending(),
		});
		await renderPage(
			<ApprovalTaskGroupPage />,
			"/approvals/task-groups/$taskGroupId",
			"/approvals/task-groups/group-1",
		);
		const region = await screen.findByRole("region", { name: "Sign to approve" });
		expect(within(region).getByText("worker-01")).toBeInTheDocument();
		expect(within(region).getByText("worker-02")).toBeInTheDocument();
		expect(within(region).queryByText("node-2")).not.toBeInTheDocument();
	});
});

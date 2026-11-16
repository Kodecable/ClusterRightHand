import type {
	ApprovalList,
	ApprovalRequest,
	ExternalCallView,
	PendingAuthorization,
	TaskGroupView,
	TaskView,
} from "@crh/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ApprovalsPage, ApprovalTaskGroupPage, ApprovalTaskPage, ExternalCallApprovalPage } from "./pages";

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
	externalCalls: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [],
});

const reviewed = (view: {
	approval?: TaskView["approval"] | TaskGroupView["approval"] | ExternalCallView["approval"];
}) => {
	const review = view.approval?.review;
	return review !== undefined && !("status" in review) ? { review: { risk: review.risk, reason: review.reason } } : {};
};

/** The compact request a task's detail response carries. */
const taskRequest = (view: TaskView, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	kind: "task",
	id: view.id,
	phase: view.phase ?? (view.state === "awaiting_authorization" ? "awaiting_signature" : "awaiting_user"),
	requester: { type: "user", userId: "u1", username: "ada" },
	action: { type: "exec", command: view.summary || view.id },
	nodes: ["worker-01"],
	moreNodes: 2,
	privileged: view.privileged,
	...reviewed(view),
	alwaysAllow: [
		{ option: "exact", rule: { action: "allow", method: "exec", nodes: ["worker-01"], exact: view.summary } },
		{ option: "prefix", rule: { action: "allow", method: "exec", nodes: ["worker-01"], prefix: view.summary } },
	],
	...overrides,
});

const groupRequest = (view: TaskGroupView, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	kind: "task_group",
	id: view.id,
	phase: view.phase ?? (view.state === "awaiting_authorization" ? "awaiting_signature" : "awaiting_user"),
	requester: { type: "user", userId: "u1", username: "ada" },
	action: { type: "exec", command: view.summary || view.id },
	nodes: ["worker-01", "worker-02"],
	privileged: view.privileged,
	...reviewed(view),
	alwaysAllow: [
		{
			option: "exact",
			rule: { action: "allow", method: "exec", nodes: ["worker-01", "worker-02"], exact: view.summary },
		},
		{
			option: "prefix",
			rule: { action: "allow", method: "exec", nodes: ["worker-01", "worker-02"], prefix: view.summary },
		},
	],
	...overrides,
});

const callRequest = (view: ExternalCallView, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => {
	const apiRequest = view.extension === "crhs-api" && view.tool === "api_request";
	return {
		kind: "external_call",
		id: view.id,
		phase: view.phase,
		requester: { type: "user", userId: "u1", username: "ada" },
		action: apiRequest
			? { type: "api_request", method: "POST", path: "/api/sessions" }
			: { type: "extension_tool", extension: view.extension, tool: view.tool },
		privileged: false,
		...reviewed(view),
		alwaysAllow: apiRequest
			? [
					{ option: "request", rule: { action: "allow", method: "api.write", exact: "POST /api/sessions" } },
					{ option: "route", rule: { action: "allow", method: "api.write", prefix: "POST /api/sessions" } },
				]
			: [
					{
						option: "tool",
						rule: { action: "allow", method: view.operation.method, exact: `${view.extension}/${view.tool}` },
					},
					{
						option: "extension",
						rule: { action: "allow", method: view.operation.method, prefix: `${view.extension}/` },
					},
				],
		...overrides,
	};
};

const approvals = (): ApprovalList => {
	const taskView = task();
	const signatureView = task({ id: "auth-task", summary: "sign me", operation: null, state: "awaiting_authorization" });
	const groupView = group();
	return {
		tasks: [taskView],
		taskGroups: [groupView],
		externalCalls: [],
		authorizations: {
			tasks: [signatureView],
			taskGroups: [],
		},
		requests: [
			taskRequest(taskView, { requester: { type: "session", sessionId: "s1", title: "Clean up" } }),
			taskRequest(signatureView),
			groupRequest(groupView),
		],
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
	};
};

const externalCall = (overrides: Partial<ExternalCallView> = {}): ExternalCallView =>
	({
		id: "call-1",
		extension: "github",
		tool: "create_issue",
		arguments: { title: "Bug" },
		operation: { method: "ext.write", target: "github/create_issue" },
		annotations: null,
		state: "awaiting_approval",
		approval: { evaluation: { result: "require-approval", levels: [] } },
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: "u1",
		rootSessionId: null,
		handlerType: "user",
		handlerSessionId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: null,
		phase: "awaiting_user",
		...overrides,
	}) as ExternalCallView;

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
	externalCall?: ExternalCallView;
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
			if (state.task !== undefined && path === `/api/tasks/${state.task.id}`)
				return json({ task: state.task, request: taskRequest(state.task) });
			if (state.task !== undefined && path === `/api/tasks/${state.task.id}/authorization`)
				return json({ authorization: state.pending ?? null });
			if (state.taskGroup !== undefined && path === `/api/task-groups/${state.taskGroup.id}`)
				return json({ taskGroup: state.taskGroup, request: groupRequest(state.taskGroup) });
			if (state.taskGroup !== undefined && path === `/api/task-groups/${state.taskGroup.id}/authorization`)
				return json({ taskGroup: { authorization: state.pending ?? null, tasks: [] } });
			const externalCall = path.match(/^\/api\/external-calls\/([^/]+)$/);
			if (externalCall !== null) {
				const id = decodeURIComponent(externalCall[1] ?? "");
				return state.externalCall?.id === id
					? json({ externalCall: state.externalCall, request: callRequest(state.externalCall) })
					: new Response(JSON.stringify({ error: "no such approval" }), {
							status: 404,
							headers: { "content-type": "application/json" },
						});
			}
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
		// Node names come from the compact requests, never the stored UUIDs; the task request is capped.
		expect(table).toHaveTextContent("worker-01 +2");
		expect(table).toHaveTextContent("worker-02");
		expect(within(table).queryByText("node-2")).not.toBeInTheDocument();
		// The asked-by cell reads the compact request: a session requester links to its session, users to theirs.
		expect(within(table).getByRole("link", { name: "Clean up" })).toHaveAttribute("href", "/sessions/s1");
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

	test("shows the Auto Review risk and reason next to the verdict", async () => {
		mockApi({
			task: task({
				approval: {
					evaluation: { result: "require-approval", levels: [] },
					review: { decision: "escalate", risk: "high", reason: "sends a credential", model: "test/reviewer" },
				},
			}),
			approvals: approvals(),
		});
		await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		const details = await screen.findByRole("region", { name: "Request details" });
		expect(within(details).getByTestId("request-review")).toHaveTextContent("Escalated");
		expect(within(details).getByTestId("request-review")).toHaveTextContent("High");
		expect(within(details).getByTestId("request-review")).toHaveTextContent("sends a credential");
		expect(within(details).getByTestId("request-review")).toHaveTextContent("test/reviewer");
		// The rule chain stays folded on the page too.
		expect(within(details).getByText("Rule chain evaluation").closest("details")).not.toHaveAttribute("open");
	});

	test("a task Auto Review is reviewing shows the notice instead of the decision", async () => {
		mockApi({ task: task({ phase: "reviewing" }), approvals: approvals() });
		await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		const notice = await screen.findByTestId("reviewing-notice");
		expect(notice).toHaveTextContent("Auto Review is reviewing this request");
		// The reviewing notice keeps the same card layout but offers no decision controls.
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		expect(card).toContainElement(notice);
		expect(within(card).queryByRole("tab")).not.toBeInTheDocument();
		expect(within(card).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
	});

	test("a task waiting for its signature shows the signature decision and rejects through the new endpoint", async () => {
		const state = mockApi({
			task: task({ state: "awaiting_authorization" }),
			pending: pending(),
			approvals: emptyApprovals(),
		});
		await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		const region = await screen.findByRole("region", { name: "Your signature is needed" });
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

	test("the task page shows the shared request details below the card", async () => {
		mockApi({
			task: task({ approval: { evaluation: { result: "require-approval", levels: [] } } }),
			approvals: approvals(),
		});
		await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		expect(await screen.findByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
		const details = screen.getByRole("region", { name: "Request details" });
		expect(within(details).getByTestId("request-evaluations")).toBeInTheDocument();
	});

	test("a settled task shows Already settled", async () => {
		mockApi({ task: task({ state: "exited" }) });
		await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		expect(await screen.findByText("Already settled")).toBeInTheDocument();
	});
});

describe("approval detail pages", () => {
	test("the task, task group and external call pages share the card and request details structure", async () => {
		mockApi({
			task: task({ approval: { evaluation: { result: "require-approval", levels: [] } } }),
			approvals: approvals(),
		});
		const taskPage = await renderPage(<ApprovalTaskPage />, "/approvals/tasks/$taskId", "/approvals/tasks/task-1");
		expect(await screen.findByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Request details" })).toBeInTheDocument();
		taskPage.unmount();

		mockApi({
			taskGroup: group({
				approval: {
					nodes: [{ nodeId: "node-1", evaluation: { result: "require-approval", levels: [] } }],
				},
			}),
		});
		const groupPage = await renderPage(
			<ApprovalTaskGroupPage />,
			"/approvals/task-groups/$taskGroupId",
			"/approvals/task-groups/group-1",
		);
		expect(await screen.findByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Request details" })).toBeInTheDocument();
		groupPage.unmount();

		mockApi({ externalCall: externalCall() });
		await renderPage(
			<ExternalCallApprovalPage />,
			"/approvals/external-calls/$externalCallId",
			"/approvals/external-calls/call-1",
		);
		expect(await screen.findByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "Request details" })).toBeInTheDocument();
	});
});

describe("ApprovalTaskGroupPage", () => {
	test("the task group page shows its operation in the shared request details", async () => {
		mockApi({
			taskGroup: group({
				approval: {
					nodes: [{ nodeId: "node-1", evaluation: { result: "require-approval", levels: [] } }],
				},
			}),
		});
		await renderPage(
			<ApprovalTaskGroupPage />,
			"/approvals/task-groups/$taskGroupId",
			"/approvals/task-groups/group-1",
		);
		const details = await screen.findByRole("region", { name: "Request details" });
		expect(within(details).getByTestId("request-content")).toHaveTextContent("Operation");
		expect(within(details).getByTestId("request-evaluations")).toBeInTheDocument();
	});

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
		const region = await screen.findByRole("region", { name: "Your signature is needed" });
		const meta = within(region).getByTestId("decision-meta");
		expect(meta).toHaveTextContent("worker-01");
		expect(meta).toHaveTextContent("worker-02");
		expect(within(region).queryByText("node-2")).not.toBeInTheDocument();
	});
});

describe("ExternalCallApprovalPage", () => {
	test("an external call waiting for the user shows the one approval panel", async () => {
		mockApi({ externalCall: externalCall() });
		await renderPage(
			<ExternalCallApprovalPage />,
			"/approvals/external-calls/$externalCallId",
			"/approvals/external-calls/call-1",
		);
		expect(await screen.findByRole("region", { name: "Your approval is needed" })).toBeInTheDocument();
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		expect(within(card).getByTestId("decision-detail")).toHaveTextContent("github/create_issue");
		// The details behind the one-line action stay on this page, not in the panel.
		const details = screen.getByRole("region", { name: "Request details" });
		expect(details).toHaveTextContent("Bug");
		expect(within(details).getByText("Arguments")).toBeInTheDocument();
		expect(within(card).queryByTestId("request-content")).not.toBeInTheDocument();
		expect(within(card).getByRole("button", { name: "Approve" })).toBeInTheDocument();
	});

	test("an external call Auto Review is reviewing shows the notice instead of the decision", async () => {
		mockApi({ externalCall: externalCall({ phase: "reviewing" }) });
		await renderPage(
			<ExternalCallApprovalPage />,
			"/approvals/external-calls/$externalCallId",
			"/approvals/external-calls/call-1",
		);
		const notice = await screen.findByTestId("reviewing-notice");
		expect(notice).toHaveTextContent("Auto Review is reviewing this request");
		// The reviewing notice keeps the same card layout but offers no decision controls.
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		expect(card).toContainElement(notice);
		expect(within(card).queryByRole("tab")).not.toBeInTheDocument();
		expect(within(card).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
	});

	test("a settled external call shows the same status badge and request details", async () => {
		mockApi({
			externalCall: externalCall({ state: "succeeded", rootSessionId: "s1", finishedAt: "2026-01-01T00:01:00.000Z" }),
		});
		await renderPage(
			<ExternalCallApprovalPage />,
			"/approvals/external-calls/$externalCallId",
			"/approvals/external-calls/call-1",
		);
		expect(await screen.findByText("Already settled")).toBeInTheDocument();
		expect(screen.getByText("Succeeded")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open the session" })).toHaveAttribute("href", "/sessions/s1");
		expect(screen.getByRole("region", { name: "Request details" })).toBeInTheDocument();
	});

	test("a missing external call is an ordinary not-found page without retention wording", async () => {
		mockApi();
		await renderPage(
			<ExternalCallApprovalPage />,
			"/approvals/external-calls/$externalCallId",
			"/approvals/external-calls/call-1",
		);
		expect(await screen.findByText("This external call doesn't exist or you don't have access.")).toBeInTheDocument();
		expect(screen.queryByText(/cleaned up/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/retention/i)).not.toBeInTheDocument();
	});
});

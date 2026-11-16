import type { ApprovalRequest, Evaluation, TaskGroupView, TaskView } from "@crh/api";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authStore } from "@/lib/session";
import { renderWithRouter, type TestLocale, testQueryClient } from "@/test/render";
import { TaskGroupPage } from "./task-group-page";
import { TaskPage } from "./task-page";

/** The route params `useParams` returns; each test sets what the page it renders reads. */
const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return { ...actual, useParams: () => route.params };
});

afterEach(() => {
	authStore.clear();
	vi.unstubAllGlobals();
});

/** Answers the page's auxiliary reads; `taskPath` gets `status` with the server's "no such task" body. */
function mockApi(taskPath: string, status: number): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith(taskPath)) {
				return new Response(JSON.stringify({ error: "no such task" }), {
					status,
					headers: { "content-type": "application/json" },
				});
			}
			const body = url.startsWith("/api/nodes")
				? { nodes: [] }
				: url.startsWith("/api/node-groups")
					? { groups: [] }
					: url.startsWith("/api/directory")
						? { users: [], userGroups: [] }
						: url.startsWith("/api/api-tokens")
							? { tokens: [] }
							: {};
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}),
	);
}

function renderPage(page: React.ReactElement, locale: TestLocale = "en") {
	return renderWithRouter(<QueryClientProvider client={testQueryClient()}>{page}</QueryClientProvider>, locale);
}

const GROUP_SUMMARY = "rm -f /tmp/worker-01.pid 2>&1";

const GROUP_TASK = {
	id: "task-1",
	nodeId: "node-1",
	kind: "exec",
	summary: GROUP_SUMMARY,
	action: { type: "exec", command: GROUP_SUMMARY },
	source: { type: "user", userId: "u1", username: "ada" },
	outcome: null,
	operation: null,
	actorType: "user",
	actorId: "u1",
	onBehalfOfUserId: "u1",
	state: "exited",
	exitCode: 0,
	signal: null,
	timedOut: false,
	cancelled: false,
	timeoutMs: null,
	errorCode: null,
	errorMessage: null,
	outputBytes: 0,
	outputHead: "",
	outputTail: "",
	outputTailLines: 0,
	outputLines: null,
	notice: null,
	maxLines: null,
	maxBytes: null,
	outputFile: null,
	outputMode: "status",
	privileged: false,
	authorization: null,
	result: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	finishedAt: "2026-01-01T00:00:01.000Z",
	taskGroupId: "g1",
	ruleChain: null,
	approval: null,
	rootSessionId: null,
	handlerType: null,
	handlerSessionId: null,
	purpose: null,
	phase: "awaiting_user",
} as TaskView;

const GROUP = {
	id: "g1",
	state: "finished",
	targets: ["node-1", "node-2"],
	refs: {
		"node-1": { kind: "node", name: "worker-01" },
		"node-2": { kind: "node", name: "worker-02" },
	},
	nodeIds: ["node-1", "node-2"],
	parallel: 1,
	failFast: false,
	outputMode: "status",
	nodeMaxLines: null,
	nodeMaxBytes: null,
	privileged: true,
	skipped: [],
	tasks: [GROUP_TASK],
	createdAt: "2026-01-01T00:00:00.000Z",
	finishedAt: "2026-01-01T00:00:01.000Z",
	summary: GROUP_SUMMARY,
	action: { type: "exec", command: GROUP_SUMMARY },
	source: { type: "user", userId: "u1", username: "ada" },
	outcome: null,
	kind: "exec",
	ruleChain: null,
	approval: null,
	actorType: "user",
	actorId: "u1",
	onBehalfOfUserId: "u1",
	operation: null,
	rootSessionId: null,
	handlerType: null,
	handlerSessionId: null,
	purpose: null,
	phase: "awaiting_user",
} as TaskGroupView;

/** Answers a successful task-group read plus the page's auxiliary lookups. */
function mockGroup(groupView: TaskGroupView = GROUP): void {
	const group = withGroupOutcome(groupView);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url.pathname === "/api/task-groups/g1" || url.pathname === "/api/task-groups/g1/wait") {
				const request =
					group.state === "awaiting_approval" || group.state === "awaiting_authorization"
						? requestFor(group, "task_group")
						: null;
				return json({ taskGroup: group, request });
			}
			if (url.pathname === "/api/nodes") {
				return json({
					nodes: [
						{ id: "node-1", name: "worker-01" },
						{ id: "node-2", name: "worker-02" },
					],
				});
			}
			if (url.pathname === "/api/node-groups") return json({ groups: [] });
			if (url.pathname === "/api/api-tokens") return json({ tokens: [] });
			if (url.pathname === "/api/directory") return json({ users: [], userGroups: [] });
			return json({});
		}),
	);
}

const TASK = { ...GROUP_TASK, id: "t1", taskGroupId: null } as TaskView;

/** The fake server's copy of the terminal classification, so an override of a flag updates the outcome. */
function withTaskOutcome(task: TaskView): TaskView {
	if (!["exited", "failed", "rejected", "unknown", "denied"].includes(task.state)) {
		return { ...task, outcome: null };
	}
	if (task.cancelled) return { ...task, outcome: { kind: "cancelled", failed: false } };
	if (task.timedOut) return { ...task, outcome: { kind: "timed_out", failed: true } };
	if (task.signal !== null) return { ...task, outcome: { kind: "signal", failed: true, signal: task.signal } };
	if (task.state === "rejected") return { ...task, outcome: { kind: "rejected", failed: true } };
	if (task.state === "denied") return { ...task, outcome: { kind: "denied", failed: true } };
	if (task.errorCode !== null) {
		return {
			...task,
			outcome: { kind: "error", failed: true, errorCode: task.errorCode, errorMessage: task.errorMessage },
		};
	}
	if (task.state === "unknown") return { ...task, outcome: { kind: "unknown", failed: true } };
	if (task.exitCode !== null) {
		if (task.exitCode === 0) {
			return {
				...task,
				outcome:
					task.kind === "exec"
						? { kind: "succeeded", failed: false, exitCode: 0 }
						: { kind: "succeeded", failed: false },
			};
		}
		return { ...task, outcome: { kind: "exit", failed: true, exitCode: task.exitCode } };
	}
	return { ...task, outcome: { kind: "unknown", failed: true } };
}

function withGroupOutcome(group: TaskGroupView): TaskGroupView {
	if (!["finished", "interrupted", "rejected", "cancelled"].includes(group.state)) {
		return { ...group, outcome: null };
	}
	if (group.state === "cancelled") return { ...group, outcome: { kind: "cancelled", failed: false } };
	if (group.state === "rejected") return { ...group, outcome: { kind: "rejected", failed: true } };
	if (group.state === "interrupted") {
		return { ...group, outcome: { kind: "error", failed: true, errorCode: "interrupted", errorMessage: null } };
	}
	const failed = group.tasks.some((task) => task.outcome?.failed === true);
	return {
		...group,
		tasks: group.tasks.map(withTaskOutcome),
		outcome: failed
			? { kind: "error", failed: true, errorCode: null, errorMessage: null }
			: { kind: "succeeded", failed: false },
	};
}

/** The compact request a detail response carries while the task or group waits. */
const requestFor = (view: TaskView | TaskGroupView, kind: "task" | "task_group"): ApprovalRequest => {
	const nodes = kind === "task" ? ["worker-01"] : ["worker-01", "worker-02"];
	return {
		kind,
		id: view.id,
		phase: view.phase ?? (view.state === "awaiting_authorization" ? "awaiting_signature" : "awaiting_user"),
		source: { type: "user", userId: "u1", username: "ada" },
		action: { type: "exec", command: view.summary },
		nodes,
		privileged: view.privileged,
		alwaysAllow: [
			{ option: "exact", rule: { action: "allow", method: "exec", nodes, exact: view.summary } },
			{ option: "prefix", rule: { action: "allow", method: "exec", nodes, prefix: view.summary } },
		],
	};
};

/** Answers a successful task read plus the page's auxiliary lookups. */
function mockTask(taskView: TaskView = TASK): void {
	const task = withTaskOutcome(taskView);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url.pathname === "/api/tasks/t1" || url.pathname === "/api/tasks/t1/wait") {
				const request =
					task.state === "awaiting_approval" || task.state === "awaiting_authorization"
						? requestFor(task, "task")
						: null;
				return json({ task, request });
			}
			// The signed-in user owns the task, so its waiting decision is shown.
			if (url.pathname === "/api/me") return json({ user: { id: "u1", username: "ada", kind: "admin" } });
			if (url.pathname === "/api/tasks/t1/authorization") return json({ authorization: null });
			if (url.pathname === "/api/nodes") return json({ nodes: [] });
			if (url.pathname === "/api/node-groups") return json({ groups: [] });
			if (url.pathname === "/api/api-tokens") return json({ tokens: [] });
			if (url.pathname === "/api/directory") return json({ users: [], userGroups: [] });
			return json({});
		}),
	);
}

/** The page header around the level-one heading. */
async function pageHeader(): Promise<HTMLElement> {
	const heading = await screen.findByRole("heading", { level: 1 });
	const header = heading.closest('[data-slot="page-header"]');
	if (!(header instanceof HTMLElement)) throw new Error("no page header");
	return header;
}

describe("TaskPage and TaskGroupPage", () => {
	test("a task the API answers 404 for shows a neutral message and no retry", async () => {
		route.params = { taskId: "t1" };
		mockApi("/api/tasks/t1", 404);
		await renderPage(<TaskPage />);

		const notice = await screen.findByTestId("task-gone");
		expect(notice).toHaveTextContent("The task was cleaned up or does not exist");
		expect(notice).toHaveClass("text-muted-foreground");
		expect(notice).not.toHaveClass("text-danger");
		expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
	});

	test("a task group the API answers 404 for shows a neutral message", async () => {
		route.params = { taskGroupId: "g1" };
		mockApi("/api/task-groups/g1", 404);
		await renderPage(<TaskGroupPage />);

		const notice = await screen.findByTestId("task-group-gone");
		expect(notice).toHaveTextContent("The task group was cleaned up or does not exist");
		expect(notice).toHaveClass("text-muted-foreground");
		expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
	});

	test("a task group is titled by its command and shows its facts once above the members", async () => {
		route.params = { taskGroupId: "g1" };
		mockGroup();
		await renderPage(<TaskGroupPage />);

		const heading = await screen.findByRole("heading", { level: 1, name: GROUP_SUMMARY });
		expect(heading.querySelector(".font-mono")).not.toBeNull();
		const header = heading.closest('[data-slot="page-header"]');
		if (!(header instanceof HTMLElement)) throw new Error("no page header");
		expect(within(header).getByText("Finished")).toBeInTheDocument();
		expect(header).not.toHaveTextContent("Privileged");
		expect(header).not.toHaveTextContent("node");
		// The outcome belongs to the facts block, not the header; the header keeps only the status.
		expect(within(header).queryByTestId("task-outcome")).not.toBeInTheDocument();
		expect(document.title).toBe(`${GROUP_SUMMARY} · ClusterRightHand`);

		// The summary appears once, as the title; the old repeated blocks and target line are gone.
		expect(screen.getAllByText(GROUP_SUMMARY)).toHaveLength(1);
		expect(screen.queryByText("Result")).not.toBeInTheDocument();
		expect(screen.queryByText("Targets:")).not.toBeInTheDocument();

		// One facts block: source, the shared privileged mark, the stored targets, the outcome and both timestamps.
		const facts = screen.getByRole("region", { name: "Task group details" });
		expect(within(facts).getByText("Privileged")).toHaveAttribute("data-slot", "privileged-mark");
		expect(within(facts).getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
		expect(within(facts).getByRole("link", { name: "worker-02" })).toHaveAttribute("href", "/nodes/node-2");
		expect(facts).toHaveTextContent("Source");
		expect(facts).toHaveTextContent("Created");
		expect(facts).toHaveTextContent("Finished at");
		expect(within(facts).getByTestId("task-outcome")).toHaveTextContent("Done");

		// The member table stays, with its row linking to the member task.
		const table = screen.getByRole("table", { name: "Tasks in this task group" });
		const member = within(table).getByTestId("task-group-member");
		expect(within(member).getByText("worker-01")).toBeInTheDocument();
		expect(within(member).getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/tasks/task-1");
	});

	test("the task and group messages have the exact zh-CN wording", async () => {
		route.params = { taskId: "t1" };
		mockApi("/api/tasks/t1", 404);
		await renderPage(<TaskPage />, "zh-CN");
		expect(await screen.findByText("任务已被清理或不存在")).toBeInTheDocument();

		route.params = { taskGroupId: "g1" };
		mockApi("/api/task-groups/g1", 404);
		await renderPage(<TaskGroupPage />, "zh-CN");
		expect(await screen.findByText("任务组已被清理或不存在")).toBeInTheDocument();
	});

	test("another error still shows the existing error state with a retry button", async () => {
		route.params = { taskId: "t1" };
		mockApi("/api/tasks/t1", 500);
		await renderPage(<TaskPage />);

		expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
		expect(screen.getByText("no such task")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(screen.queryByTestId("task-gone")).not.toBeInTheDocument();
	});

	test("the header adds a non-zero exit code after the status", async () => {
		route.params = { taskId: "t1" };
		mockTask({ ...TASK, exitCode: 3 });
		await renderPage(<TaskPage />);

		const header = await pageHeader();
		expect(header).toHaveTextContent("Finished · Exit code 3");
		const outcome = within(header).getByTestId("task-outcome");
		expect(outcome).toHaveTextContent("Exit code 3");
		expect(outcome).toHaveAttribute("data-tone", "danger");
	});

	test("the header says a task timed out", async () => {
		route.params = { taskId: "t1" };
		mockTask({ ...TASK, timedOut: true });
		await renderPage(<TaskPage />);

		const header = await pageHeader();
		expect(header).toHaveTextContent("Finished · Timed out");
		expect(within(header).getByTestId("task-outcome")).toHaveTextContent("Timed out");
	});

	test("the header says a task was cancelled", async () => {
		route.params = { taskId: "t1" };
		mockTask({ ...TASK, cancelled: true });
		await renderPage(<TaskPage />);

		const header = await pageHeader();
		expect(header).toHaveTextContent("Finished · Cancelled");
		expect(within(header).getByTestId("task-outcome")).toHaveTextContent("Cancelled");
	});

	test("a running task's header shows only its status, no outcome", async () => {
		route.params = { taskId: "t1" };
		mockTask({ ...TASK, state: "running", exitCode: null, finishedAt: null });
		await renderPage(<TaskPage />);

		const header = await pageHeader();
		expect(within(header).getByText("Running")).toBeInTheDocument();
		expect(within(header).queryByTestId("task-outcome")).not.toBeInTheDocument();
	});

	test("a failed task with nothing to show has no empty Result box", async () => {
		route.params = { taskId: "t1" };
		mockTask({
			...TASK,
			state: "failed",
			exitCode: null,
			errorCode: "permission_denied",
			errorMessage: "permission denied",
			outputMode: "full",
			outputBytes: 0,
			outputHead: "",
			outputTail: "",
			notice: null,
			result: null,
		});
		await renderPage(<TaskPage />);

		await screen.findByTestId("task-page");
		expect(screen.queryByRole("region", { name: "Result" })).not.toBeInTheDocument();
	});

	test("an exited task with output keeps its Result box", async () => {
		route.params = { taskId: "t1" };
		mockTask({ ...TASK, outputMode: "full", outputBytes: 12, outputHead: "hello\n", outputTail: "" });
		await renderPage(<TaskPage />);

		const result = await screen.findByRole("region", { name: "Result" });
		expect(within(result).getByLabelText("output")).toHaveTextContent("hello");
	});

	test("a task waiting for approval shows the shared decision inline", async () => {
		route.params = { taskId: "t1" };
		mockTask({ ...TASK, state: "awaiting_approval", finishedAt: null });
		await authStore.load();
		await renderPage(<TaskPage />);

		const decision = await screen.findByRole("region", { name: "Your approval is needed" });
		expect(within(decision).getByRole("button", { name: "Approve" })).toBeInTheDocument();
		expect(within(decision).getByRole("tab", { name: "Reject" })).toBeInTheDocument();
	});

	test("a task Auto Review is reviewing shows the notice instead of decision controls", async () => {
		route.params = { taskId: "t1" };
		mockTask({ ...TASK, state: "awaiting_approval", finishedAt: null, phase: "reviewing" });
		await renderPage(<TaskPage />);

		const notice = await screen.findByTestId("reviewing-notice");
		expect(notice).toHaveTextContent("Auto Review is reviewing this request");
		// The reviewing notice keeps the same card layout but offers no decision controls.
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		expect(card).toContainElement(notice);
		expect(within(card).queryByRole("tab")).not.toBeInTheDocument();
		expect(within(card).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
	});

	test("a task group Auto Review is reviewing shows the notice instead of decision controls", async () => {
		route.params = { taskGroupId: "g1" };
		mockGroup({ ...GROUP, state: "awaiting_approval", finishedAt: null, phase: "reviewing" });
		await renderPage(<TaskGroupPage />);

		const notice = await screen.findByTestId("reviewing-notice");
		expect(notice).toHaveTextContent("Auto Review is reviewing this request");
		// The reviewing notice keeps the same card layout but offers no decision controls.
		const card = screen.getByRole("region", { name: "Your approval is needed" });
		expect(card).toContainElement(notice);
		expect(within(card).queryByRole("tab")).not.toBeInTheDocument();
		expect(within(card).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
	});

	test("a task waiting for its signature shows the signature decision inline", async () => {
		route.params = { taskId: "t1" };
		mockTask({ ...TASK, state: "awaiting_authorization", finishedAt: null, phase: "awaiting_signature" });
		await authStore.load();
		await renderPage(<TaskPage />);

		const decision = await screen.findByRole("region", { name: "Your signature is needed" });
		expect(within(decision).getByRole("tab", { name: "crha grant" })).toBeInTheDocument();
		expect(within(decision).getByRole("tab", { name: "Reject" })).toBeInTheDocument();
	});

	test("an exited task with an approval still shows the rule chain evaluation", async () => {
		route.params = { taskId: "t1" };
		const evaluation: Evaluation = {
			result: "allow",
			levels: [
				{
					scope: { type: "session", id: "s1" },
					own: "allow",
					rule: 0,
					matched: { action: "allow", method: "exec", exact: "rm -f /tmp/worker-01.pid" },
					effective: "allow",
				},
			],
		};
		mockTask({ ...TASK, approval: { evaluation } });
		await renderPage(<TaskPage />);

		await screen.findByTestId("task-page");
		expect(screen.getByText("Rule chain evaluation")).toBeInTheDocument();
		expect(screen.getByRole("table", { name: "Rule chain evaluation" })).toBeInTheDocument();
	});
});

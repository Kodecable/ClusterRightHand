import type { TaskGroupView, TaskView } from "@crh/api";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
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
} as TaskGroupView;

/** Answers a successful task-group read plus the page's auxiliary lookups. */
function mockGroup(group: TaskGroupView = GROUP): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url.pathname === "/api/task-groups/g1" || url.pathname === "/api/task-groups/g1/wait") {
				return json({ taskGroup: group });
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

	test("a task group is titled by its command, keeps only its status above the members and drops the repeated header blocks", async () => {
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
		expect(document.title).toBe(`${GROUP_SUMMARY} · ClusterRightHand`);

		// The summary appears once, as the title; the old repeated blocks and target line are gone.
		expect(screen.getAllByText(GROUP_SUMMARY)).toHaveLength(1);
		expect(screen.queryByText("Result")).not.toBeInTheDocument();
		expect(screen.queryByText("Privileged")).not.toBeInTheDocument();
		expect(screen.queryByText("Targets:")).not.toBeInTheDocument();
		expect(screen.queryByTestId("task-group-targets")).not.toBeInTheDocument();
		expect(screen.queryByText(/2 nodes/)).not.toBeInTheDocument();

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
});

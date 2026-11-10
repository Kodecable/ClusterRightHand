import type { TaskView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { TasksPage } from "./pages";
import type { TasksSearch } from "./search";

const TASK: TaskView = {
	id: "task-1",
	nodeId: "node-1",
	kind: "exec",
	summary: "echo hi",
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
	taskGroupId: null,
	ruleChain: null,
	approval: null,
	rootSessionId: null,
	handlerType: null,
	handlerSessionId: null,
};

interface MockOptions {
	items?: TaskView[];
	nodes?: { id: string; name: string }[];
	users?: { id: string; username: string; displayName: string }[];
}

function mockApi({ items = [], nodes = [], users = [] }: MockOptions = {}): { urls: string[] } {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			const body = url.startsWith("/api/tasks")
				? { items, nextCursor: null }
				: url.startsWith("/api/nodes")
					? { nodes }
					: url.startsWith("/api/directory")
						? { users, userGroups: [] }
						: { ok: true };
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}),
	);
	return { urls };
}

async function renderPage(initialEntries: string[] = ["/tasks"]) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderWithRouter(
		<QueryClientProvider client={client}>
			<TasksPage />
		</QueryClientProvider>,
		"en",
		{ path: "/tasks", initialEntries },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TasksPage filters", () => {
	test("starts unfiltered and sends the chosen state to the server", async () => {
		const { urls } = mockApi();
		await renderPage();
		await waitFor(() => expect(urls.some((url) => url.startsWith("/api/tasks"))).toBe(true));
		expect(urls.find((url) => url.startsWith("/api/tasks"))).not.toContain("state=");

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("State"));
		// Every state the filter can match is offered, including cancelled.
		expect(await screen.findByRole("option", { name: "Cancelled" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Finished" })).toBeInTheDocument();
		const failed = await screen.findByRole("option", { name: "Failed" });
		await user.click(failed);
		await waitFor(() =>
			expect(urls.some((url) => url.startsWith("/api/tasks") && url.includes("state=failed"))).toBe(true),
		);
	});

	test("a task row links to the task page from its summary cell", async () => {
		mockApi({ items: [TASK] });
		await renderPage();
		const link = await screen.findByRole("link", { name: "echo hi" });
		expect(link).toHaveAttribute("href", "/tasks/task-1");
		// The first column is Created, so the summary cell carries the row link.
		expect(screen.getByText("echo hi").closest("a")).toBe(link);
	});

	test("does not link to the approvals page", async () => {
		mockApi();
		await renderPage();
		expect(screen.queryByTestId("waiting-for-me")).not.toBeInTheDocument();
	});
});

describe("TasksPage URL filters", () => {
	test("?node= preselects the node and filters the request; clearing writes the filter back", async () => {
		const { urls } = mockApi({ nodes: [{ id: "node-1", name: "worker-01" }] });
		const { router } = await renderPage(["/tasks?node=node-1"]);
		await waitFor(() =>
			expect(urls.some((url) => url.startsWith("/api/tasks") && url.includes("nodeId=node-1"))).toBe(true),
		);
		await waitFor(() => expect(screen.getByLabelText("Node")).toHaveTextContent("worker-01"));

		const user = userEvent.setup();
		await user.click(screen.getByLabelText("Node"));
		await user.click(await screen.findByRole("option", { name: "Any node" }));
		const search = router.state.location.search as TasksSearch;
		await waitFor(() => expect(search.node).toBeUndefined());
		await waitFor(() =>
			expect(urls.some((url) => url.startsWith("/api/tasks") && !url.includes("nodeId="))).toBe(true),
		);
	});

	test("?user= shows the user beside the filters, sends userId, and can be cleared", async () => {
		const { urls } = mockApi({ users: [{ id: "u2", username: "alice", displayName: "Alice" }] });
		const { router } = await renderPage(["/tasks?user=u2"]);
		await waitFor(() =>
			expect(urls.some((url) => url.startsWith("/api/tasks") && url.includes("userId=u2"))).toBe(true),
		);
		const indicator = await screen.findByTestId("user-filter");
		expect(indicator).toHaveTextContent("User: Alice");

		await userEvent.setup().click(screen.getByRole("button", { name: "Clear user filter" }));
		const search = router.state.location.search as TasksSearch;
		await waitFor(() => expect(search.user).toBeUndefined());
		await waitFor(() => expect(screen.queryByTestId("user-filter")).not.toBeInTheDocument());
		await waitFor(() =>
			expect(urls.some((url) => url.startsWith("/api/tasks") && !url.includes("userId="))).toBe(true),
		);
	});
});

describe("TasksPage run task", () => {
	test("the page header opens the Run task dialog", async () => {
		mockApi();
		await renderPage();
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "Run task" }));
		expect(await screen.findByRole("dialog", { name: "Run task" })).toBeInTheDocument();
	});
});

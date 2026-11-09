import type { TaskView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { TasksPage } from "./pages";

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

function mockApi(items: TaskView[] = []): { urls: string[] } {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			const body = url.startsWith("/api/tasks")
				? { items, nextCursor: null }
				: url.startsWith("/api/nodes")
					? { nodes: [] }
					: url.startsWith("/api/directory")
						? { users: [], userGroups: [] }
						: { ok: true };
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		}),
	);
	return { urls };
}

async function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderWithRouter(
		<QueryClientProvider client={client}>
			<TasksPage />
		</QueryClientProvider>,
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
		mockApi([TASK]);
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

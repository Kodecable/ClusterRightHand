import type { TaskView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { NodeTaskList } from "./node-tasks";

function task(overrides: Partial<TaskView> = {}): TaskView {
	return {
		id: "task-1",
		nodeId: "node-1",
		kind: "exec",
		summary: "uptime",
		operation: null,
		actorType: "user",
		actorId: "u1",
		onBehalfOfUserId: null,
		state: "exited",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		errorCode: null,
		errorMessage: null,
		outputBytes: 0,
		outputHead: "",
		outputTail: "",
		outputTailLines: 0,
		outputLines: null,
		notice: null,
		outputFile: null,
		outputMode: "status",
		privileged: false,
		result: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		finishedAt: "2026-01-01T00:00:01.000Z",
		...overrides,
	} as TaskView;
}

function mockApi(tasks: TaskView[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost").pathname;
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (url === "/api/nodes/node-1/tasks") return json({ tasks });
			if (url === "/api/directory") return json({ users: [], userGroups: [] });
			return json({});
		}),
	);
}

async function renderList(tasks: TaskView[]): Promise<void> {
	mockApi(tasks);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<NodeTaskList nodeId="node-1" />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test("a recent task's row links to the task page; there is no Details column", async () => {
	await renderList([task(), task({ id: "task-2", summary: "whoami", state: "running" })]);
	const first = await screen.findByRole("link", { name: "uptime" });
	expect(first).toHaveAttribute("href", "/tasks/task-1");
	expect(screen.getByRole("link", { name: "whoami" })).toHaveAttribute("href", "/tasks/task-2");
	// One row link per task and no separate "Details" link.
	expect(screen.getAllByRole("link")).toHaveLength(2);
	expect(screen.queryByRole("link", { name: "Details" })).not.toBeInTheDocument();
	// The summary itself is plain text, and the section has no refresh button.
	expect(screen.getByText("uptime").closest("a")).toBeNull();
	expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
});

test("the summary and the kind are shown together per node", async () => {
	await renderList([task({ summary: "uptime", kind: "exec" })]);
	const row = (await screen.findByText("uptime")).closest('[role="row"]');
	if (!(row instanceof HTMLElement)) throw new Error("no task row");
	expect(within(row).getByText("(exec)")).toBeInTheDocument();
});

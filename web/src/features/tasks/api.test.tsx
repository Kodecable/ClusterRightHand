import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { taskKeys, useCancelTask } from "./api";

function mockFetch(): string[] {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			calls.push(new URL(String(input), "http://localhost").pathname);
			return new Response(JSON.stringify({ cancelled: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

function CancelTaskHarness({ id }: { id: string }) {
	const cancel = useCancelTask(id);
	return (
		<button type="button" onClick={() => cancel.mutate()}>
			Stop task
		</button>
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useCancelTask", () => {
	test("refreshes the task, its list and its task group", async () => {
		const calls = mockFetch();
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		client.setQueryData(taskKeys.detail("task-1"), { id: "task-1" });
		client.setQueryData(taskKeys.listPage({}), { pages: [{ items: [], nextCursor: null }], pageParams: [null] });
		client.setQueryData(taskKeys.group("group-1"), { id: "group-1" });

		render(
			<QueryClientProvider client={client}>
				<CancelTaskHarness id="task-1" />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Stop task" }));

		await waitFor(() => expect(calls).toContain("/api/tasks/task-1/cancel"));
		await waitFor(() => {
			expect(client.getQueryState(taskKeys.detail("task-1"))?.isInvalidated).toBe(true);
			expect(client.getQueryState(taskKeys.listPage({}))?.isInvalidated).toBe(true);
			expect(client.getQueryState(taskKeys.group("group-1"))?.isInvalidated).toBe(true);
		});
	});
});

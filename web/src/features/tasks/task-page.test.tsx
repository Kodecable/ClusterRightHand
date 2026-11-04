import { QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
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

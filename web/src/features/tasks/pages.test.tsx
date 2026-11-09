import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { TasksPage } from "./pages";

function mockApi(): { urls: string[] } {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			const body = url.startsWith("/api/tasks")
				? { items: [], nextCursor: null }
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

	test("does not link to the approvals page", async () => {
		mockApi();
		await renderPage();
		expect(screen.queryByTestId("waiting-for-me")).not.toBeInTheDocument();
	});
});

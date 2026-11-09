import type { ScheduleRunView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { RunHistory } from "./run-history";

function run(overrides: Partial<ScheduleRunView> = {}): ScheduleRunView {
	return {
		id: "run-1",
		scheduleId: "schedule-1",
		status: "succeeded",
		reason: null,
		manual: false,
		fireTime: "2026-01-01T09:00:00.000Z",
		startedAt: "2026-01-01T09:00:00.000Z",
		finishedAt: "2026-01-01T09:00:01.000Z",
		createdAt: "2026-01-01T09:00:00.000Z",
		sessionId: null,
		...overrides,
	};
}

function mockApi(runs: ScheduleRunView[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ items: runs, nextCursor: null }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
}

async function renderHistory(runs: ScheduleRunView[]): Promise<void> {
	mockApi(runs);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<RunHistory scheduleId="schedule-1" inProgress={false} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test("a run with a session links to the session from the whole row", async () => {
	await renderHistory([run({ id: "run-1", sessionId: "sess1234-aaaa" }), run({ id: "run-2", sessionId: null })]);
	const link = await screen.findByRole("link", { name: "Open session sess1234" });
	expect(link).toHaveAttribute("href", "/sessions/sess1234-aaaa");
	// Only the run with a session has a row link; the short id stays plain mono text.
	expect(screen.getAllByRole("link")).toHaveLength(1);
	expect(screen.getByText("sess1234").closest("a")).toBeNull();
	// No section-level refresh button: the section polls or is invalidated.
	expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
});

test("a run without a session has no link", async () => {
	await renderHistory([run({ sessionId: null })]);
	await screen.findByText("Succeeded");
	expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

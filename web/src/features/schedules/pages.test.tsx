import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ScheduleView } from "@/lib/api/types";
import { renderWithRouter } from "@/test/render";
import { SchedulesPage } from "./pages";

const SCHEDULE: ScheduleView = {
	id: "schedule-1",
	ownerUserId: "u1",
	name: "Nightly check",
	prompt: "Check the nodes",
	model: { provider: "faux", modelId: "faux-1" },
	preset: "ask",
	rules: [],
	tokenBudget: null,
	cron: "0 9 * * *",
	timezone: "Not/AZone",
	catchUp: false,
	enabled: true,
	nextRunAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	lastRun: null,
	inProgress: false,
	preview: [],
	previewError: "invalid timezone: Not/AZone",
};

function mockFetch(schedules: ScheduleView[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input), "http://localhost").pathname;
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
			if (path === "/api/schedules") return json({ schedules });
			if (path === "/api/models") return json({ models: [] });
			return json({});
		}),
	);
}

async function renderPage(schedules: ScheduleView[]): Promise<void> {
	mockFetch(schedules);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<SchedulesPage />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test("a schedule whose stored timezone is invalid explains the empty preview", async () => {
	await renderPage([SCHEDULE]);
	expect(await screen.findByTestId("schedule-preview-error")).toHaveTextContent("invalid timezone: Not/AZone");
});

test("a valid schedule shows no preview error", async () => {
	await renderPage([{ ...SCHEDULE, timezone: "Europe/Berlin", previewError: null }]);
	expect(await screen.findByText("Nightly check")).toBeInTheDocument();
	expect(screen.queryByTestId("schedule-preview-error")).not.toBeInTheDocument();
});

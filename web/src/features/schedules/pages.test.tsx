import type { ScheduleView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { SchedulesPage } from "./pages";

const SCHEDULE: ScheduleView = {
	id: "schedule-1",
	ownerUserId: "u1",
	name: "Nightly check",
	prompt: "Check the nodes",
	model: { provider: "faux", modelId: "faux-1" },
	rulePreset: "ask",
	rules: [],
	refs: {},
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

test("the schedule name is plain text and the row links to the detail page", async () => {
	await renderPage([{ ...SCHEDULE, timezone: "Europe/Berlin", previewError: null }]);
	const link = await screen.findByRole("link", { name: "Nightly check" });
	expect(link).toHaveAttribute("href", "/schedules/schedule-1");
	// The name itself is not a link; the row's stretched link carries the accessible name.
	expect(screen.getByText("Nightly check").closest("a")).toBeNull();
	// "Run now" stays in the row, and there is no page-level refresh button.
	expect(screen.getByRole("button", { name: "Run now" })).toBeInTheDocument();
	expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
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

test("a disabled schedule has no next run and says so in its status", async () => {
	await renderPage([
		{
			...SCHEDULE,
			enabled: false,
			timezone: "Europe/Berlin",
			previewError: null,
			nextRunAt: "2026-02-01T09:00:00.000Z",
			lastRun: {
				id: "run-1",
				scheduleId: SCHEDULE.id,
				status: "succeeded",
				reason: null,
				manual: false,
				fireTime: "2026-01-01T09:00:00.000Z",
				startedAt: "2026-01-01T09:00:00.000Z",
				finishedAt: "2026-01-01T09:00:01.000Z",
				createdAt: "2026-01-01T09:00:00.000Z",
				sessionId: null,
			},
		},
	]);
	const name = await screen.findByText("Nightly check");
	const row = name.closest('[role="row"]');
	if (!(row instanceof HTMLElement)) throw new Error("no schedule row");
	// The next-run cell is the muted placeholder, not a Disabled badge.
	expect(row).toHaveTextContent("–");
	expect(row).toHaveTextContent("Disabled");
	expect(row).not.toHaveTextContent("Succeeded");
});

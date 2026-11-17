import type { ScheduleView } from "@crh/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ScheduleDetailPage, SchedulesPage } from "./pages";

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
	report: null,
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
			if (path === "/api/schedules/preview") return json({ times: [] });
			if (path.startsWith("/api/schedules/") && path.endsWith("/runs")) return json({ items: [], nextCursor: null });
			if (path.startsWith("/api/schedules/")) return json({ schedule: schedules[0] });
			if (path === "/api/models") return json({ models: [] });
			if (path === "/api/channel-accounts")
				return json({
					accounts: [
						{
							id: "acc-1",
							channelId: "channel-1",
							channelName: "telegram-main",
							platform: "telegram",
							platformUserId: "42",
							displayName: "Alice",
							linkedAt: "2026-01-01T00:00:00.000Z",
							isDefault: false,
						},
					],
					channels: [],
				});
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

async function renderDetail(schedule: ScheduleView): Promise<void> {
	mockFetch([schedule]);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await renderWithRouter(
		<QueryClientProvider client={client}>
			<ScheduleDetailPage />
		</QueryClientProvider>,
		"en",
		{ path: "/schedules/$scheduleId", initialEntries: [`/schedules/${schedule.id}`] },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test("the schedule name is the row's link to the detail page", async () => {
	await renderPage([{ ...SCHEDULE, timezone: "Europe/Berlin", previewError: null }]);
	const link = await screen.findByRole("link", { name: "Nightly check" });
	expect(link).toHaveAttribute("href", "/schedules/schedule-1");
	// The name itself is the row's single link, inside its first cell.
	expect(screen.getByText("Nightly check").closest("a")).toBe(link);
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

test("the detail page shows the report target and when it is sent", async () => {
	await renderDetail({
		...SCHEDULE,
		timezone: "Europe/Berlin",
		previewError: null,
		report: { accountId: "acc-1", on: "failure" },
	});
	const [report] = await screen.findAllByTestId("schedule-report");
	if (!report) throw new Error("no report setting");
	expect(report).toHaveTextContent("Report:");
	expect(report).toHaveTextContent("Alice (telegram-main)");
	expect(report).toHaveTextContent("Only on failure");
});

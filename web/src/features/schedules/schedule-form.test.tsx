import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AvailableModel } from "@/lib/api/types";
import { activateLocale, renderWithI18n } from "@/test/render";
import { ScheduleForm, scheduleFormStateOf } from "./schedule-form";
import { type ParsedSchedule, rulePresetNoteText } from "./scheduleForm";

const MODELS: AvailableModel[] = [{ provider: "faux", modelId: "faux-1", name: "Faux One", contextWindow: 128_000 }];

function mockFetch(): { calls: { body: unknown; url: string }[] } {
	const calls: { body: unknown; url: string }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ url, body });
			const json = url.startsWith("/api/schedules/preview")
				? { times: ["2026-02-01T09:00:00.000Z", "2026-02-02T09:00:00.000Z"] }
				: {};
			return new Response(JSON.stringify(json), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return { calls };
}

function renderForm(onSubmit: (input: ParsedSchedule) => void) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderWithI18n(
		<QueryClientProvider client={client}>
			<ScheduleForm
				initial={{ ...scheduleFormStateOf(), prompt: "Run the check", model: MODELS[0] }}
				models={MODELS}
				submitLabel="Save schedule"
				onSubmit={onSubmit}
			/>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ScheduleForm", () => {
	test("asks the server for the next fire times of the cron and timezone", async () => {
		const { calls } = mockFetch();
		renderForm(vi.fn());
		await waitFor(() => expect(calls.some((call) => call.url.startsWith("/api/schedules/preview"))).toBe(true));
		const preview = calls.find((call) => call.url.startsWith("/api/schedules/preview"));
		expect(preview?.body).toEqual({
			cron: "0 9 * * *",
			timezone: scheduleFormStateOf().timezone,
			count: 5,
		});
		// The preview's times are rendered as one sortable line each.
		await screen.findByText("Expected to fire at:");
		const times = screen.getAllByTestId("schedule-preview-time");
		expect(times).toHaveLength(2);
		for (const time of times) {
			expect(time).toHaveTextContent(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		}
		expect(screen.getByText("……")).toBeInTheDocument();
	});

	test("warns for Ask and Yolo, and says nothing for Auto Review", () => {
		activateLocale("en");
		expect(rulePresetNoteText(i18n, "ask")).toMatch(/pause the schedule/);
		expect(rulePresetNoteText(i18n, "auto_review")).toBeNull();
		expect(rulePresetNoteText(i18n, "yolo")).toMatch(/without asking or checking/);
	});

	test("shows translated validation codes and does not submit", async () => {
		mockFetch();
		const onSubmit = vi.fn();
		renderForm(onSubmit);
		const user = userEvent.setup();

		const cron = screen.getByLabelText("Cron");
		await user.clear(cron);
		await user.type(cron, "0 0 * * * *");
		const name = screen.getByLabelText("Name");
		await user.clear(name);

		await user.click(screen.getByRole("button", { name: "Save schedule" }));
		await screen.findByText("A name is required.");
		await screen.findByText("A cron expression has exactly five fields.");
		expect(onSubmit).not.toHaveBeenCalled();

		await user.type(name, "Nightly");
		await user.clear(cron);
		await user.type(cron, "0 9 * * *");
		await user.click(screen.getByRole("button", { name: "Save schedule" }));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ name: "Nightly", cron: "0 9 * * *" });
	});
});

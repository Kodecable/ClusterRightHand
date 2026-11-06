import { expect, test } from "@playwright/test";
import { login, mockApi } from "./helpers";

test("the schedule form drops redundant help and warns only for Ask and Yolo", async ({ page }) => {
	await mockApi(page, {
		state: {
			models: [
				{
					provider: "faux",
					modelId: "faux-1",
					name: "Faux One",
					contextWindow: 128_000,
					thinkingLevels: ["off"],
					input: ["text"],
				},
			],
		},
	});
	await login(page);
	await page.goto("/schedules");
	await page.getByTestId("new-schedule").click();
	const dialog = page.getByRole("dialog", { name: "New schedule" });
	await expect(dialog).toBeVisible();

	for (const removed of [
		"A schedule creates a new session at every trigger and submits a fixed prompt.",
		"Shown in the schedule list; at most 200 characters.",
		"Every run starts a fresh session with this prompt.",
		"The model every new session of this schedule uses.",
		"Counts model output tokens, not input. Empty means unlimited.",
		"Defaults to this browser's timezone.",
		"Runs once when crhs starts again if a trigger was missed while it was down.",
		"Ask: every approval waits for you, while the next trigger still ends the run. Unattended runs will be stopped at the next fire if you are not there.",
		"Auto Review: approvals first go to a review model; anything risky still waits for you, with the same caveat as Ask.",
	]) {
		await expect(dialog.getByText(removed, { exact: true })).toHaveCount(0);
	}
	await expect(dialog.getByText("Catch up a missed trigger immediately")).toBeVisible();
	await expect(dialog.getByText("Expected to fire at:")).toBeVisible();
	await expect(dialog.getByTestId("schedule-preview-time")).toHaveCount(2);
	await expect(dialog.getByText("……")).toBeVisible();

	const askNote = dialog.getByText(
		"The Ask rule preset can often pause the schedule while it waits for your confirmation.",
	);
	await expect(askNote).toHaveClass(/text-warn/);

	await page.getByLabel("Rule preset").click();
	await page.getByRole("option", { name: "Auto Review" }).click();
	await expect(askNote).toHaveCount(0);

	await page.getByLabel("Rule preset").click();
	await page.getByRole("option", { name: "Yolo" }).click();
	await expect(dialog.getByText("The Yolo rule preset runs every action without asking or checking.")).toHaveClass(
		/text-warn/,
	);
});

test("create a schedule and run it now", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			models: [
				{
					provider: "faux",
					modelId: "faux-1",
					name: "Faux One",
					contextWindow: 128_000,
					thinkingLevels: ["off"],
					input: ["text"],
				},
			],
		},
	});
	await login(page);
	await page.goto("/schedules");
	await expect(page.getByTestId("schedules-page")).toBeVisible();

	await page.getByTestId("new-schedule").click();
	const dialog = page.getByRole("dialog", { name: "New schedule" });
	await expect(dialog).toBeVisible();

	await page.getByLabel("Name").fill("Nightly check");
	await page.getByLabel("Prompt").fill("Check the nodes");
	await page.getByLabel("Model").click();
	await page.getByRole("option", { name: "Faux One" }).click();
	await page.getByRole("button", { name: "Create schedule" }).click();

	await expect(page).toHaveURL(/\/schedules\/schedule-1$/);
	await expect(page.getByRole("heading", { name: "Nightly check" })).toBeVisible();
	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/schedules");
	expect(created?.body).toMatchObject({
		name: "Nightly check",
		prompt: "Check the nodes",
		model: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
		rulePreset: "ask",
		cron: "0 9 * * *",
		enabled: true,
	});

	await page.getByRole("button", { name: "Run now" }).click();
	await expect(page.getByText("Run started.")).toBeVisible();
	await expect
		.poll(() => api.state.requests.some((request) => request.url === "/api/schedules/schedule-1/run"))
		.toBe(true);
	// The started run shows up in the history table.
	await expect(page.getByTestId("schedule-runs")).toContainText("running");
});

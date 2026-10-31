import { expect, test } from "@playwright/test";
import { login, mockApi } from "./helpers";

test("create a schedule and run it now", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			models: [{ provider: "faux", modelId: "faux-1", name: "Faux One", contextWindow: 128_000 }],
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
		model: { provider: "faux", modelId: "faux-1" },
		preset: "ask",
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

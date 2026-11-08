import type { Page } from "@playwright/test";
import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { fauxAssistantMessage, fauxText } from "../../server/test/e2e/harness.ts";
import { expect, modelName, test } from "./fixtures.ts";

test.use({ withAgent: true });

/** Creates a schedule from the Schedules page and lands on its detail page. */
async function newSchedule(page: Page, crhs: InProcessCrhs, name: string, prompt: string) {
	await page.goto("/schedules");
	await page.getByTestId("new-schedule").click();
	const dialog = page.getByRole("dialog", { name: "New schedule" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByLabel("Prompt").fill(prompt);
	await dialog.getByLabel("Model").click();
	await page.getByRole("option", { name: modelName(crhs) }).click();
	await dialog.getByRole("button", { name: "Create schedule" }).click();
	await expect(page.getByTestId("page-title")).toHaveText("Schedules");
	await expect(page.getByRole("heading", { name })).toBeVisible();
}

test("create a schedule, run it now and open the run's session", async ({ adminPage: page, crhs }) => {
	crhs.faux.setResponses([fauxAssistantMessage([fauxText("Scheduled check done.")])]);
	await newSchedule(page, crhs, "Nightly check", "Check the nodes");

	// The form previewed the next fire times the server computed for the cron.
	const preview = page.getByRole("status", { name: "Expected triggers" });
	await expect(preview).toContainText("Expected to fire at:");
	await expect(preview.getByTestId("schedule-preview-time").first()).toBeVisible();

	await page.getByRole("button", { name: "Run now" }).click();
	const history = page.getByRole("table", { name: "Schedule runs" });
	await expect(history).toContainText("Succeeded", { timeout: 20_000 });
	await expect(page.getByText("Last result:")).toContainText("Succeeded");

	// The run links to the session it created; the prompt is there and the answer arrived.
	await history.getByRole("link").first().click();
	await expect(page).toHaveURL(/\/sessions\//);
	const log = page.getByTestId("transcript-scroller");
	await expect(log).toContainText("Check the nodes");
	await expect(log).toContainText("Scheduled check done.");
});

test("a schedule can be disabled from the list and deleted from its page", async ({ adminPage: page, crhs }) => {
	await newSchedule(page, crhs, "Disable me", "Do nothing");
	await page.getByTestId("nav-schedules").click();
	const row = page.getByRole("row").filter({ hasText: "Disable me" });
	const enabled = row.getByRole("switch", { name: "Enabled: Disable me" });
	await expect(enabled).toBeChecked();
	await enabled.click();
	await expect(enabled).not.toBeChecked();
	await expect(row).toContainText("Disabled", { timeout: 10_000 });

	await row.getByRole("link", { name: "Disable me" }).click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Delete Disable me?" });
	await dialog.getByRole("button", { name: "Delete schedule" }).click();
	await expect(page.getByTestId("page-title")).toHaveText("Schedules");
	await expect(page.getByRole("row").filter({ hasText: "Disable me" })).toHaveCount(0);
});

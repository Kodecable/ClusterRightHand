import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { Page } from "@playwright/test";
import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withAgent: true });

const modelLabel = (crhs: InProcessCrhs) => crhs.faux.getModel().name;

/** Creates a schedule from the Schedules page and lands on its detail page. */
async function newSchedule(page: Page, crhs: InProcessCrhs, name: string, prompt: string) {
	await page.goto("/#/schedules");
	await page.getByRole("button", { name: "New schedule" }).click();
	const dialog = page.getByRole("dialog", { name: "New schedule" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByLabel("Prompt").fill(prompt);
	await dialog.getByLabel("Model", { exact: true }).selectOption({ label: modelLabel(crhs) });
	await dialog.getByRole("button", { name: "Create schedule" }).click();
	await expect(page.getByRole("heading", { name })).toBeVisible();
}

test("create a schedule, run it now and open the run's session", async ({ adminPage: page, crhs }) => {
	crhs.faux.setResponses([fauxAssistantMessage([fauxText("Scheduled check done.")])]);
	await newSchedule(page, crhs, "Nightly check", "Check the nodes");

	// The form previewed the next fire times the server computed for the cron.
	await expect(page.getByRole("status", { name: "Next runs" })).not.toContainText("Next runs: -");

	await page.getByRole("button", { name: "Run now" }).click();
	const history = page.getByRole("table", { name: "Schedule runs" });
	await expect(history).toContainText("succeeded", { timeout: 20_000 });
	await expect(page.getByText("Last result:")).toContainText("succeeded");

	// The run links to the session it created; the prompt is there and the answer arrived.
	await history.getByRole("link").first().click();
	await expect(page).toHaveURL(/#\/sessions\//);
	const log = page.getByRole("log", { name: "Conversation" });
	await expect(log).toContainText("Check the nodes");
	await expect(log).toContainText("Scheduled check done.");
});

test("a schedule can be disabled from the list and deleted from its page", async ({ adminPage: page, crhs }) => {
	await newSchedule(page, crhs, "Disable me", "Do nothing");
	await page.getByRole("link", { name: "Schedules" }).click();
	const row = page.getByRole("row", { name: /Disable me/ });
	await expect(row).toContainText("enabled");
	await row.getByRole("checkbox", { name: "Enabled Disable me" }).click();
	await expect(row).toContainText("disabled", { timeout: 10_000 });

	await row.getByRole("link", { name: "Disable me" }).click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Delete Disable me?" });
	await dialog.getByRole("button", { name: "Delete schedule" }).click();
	await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
	await expect(page.getByRole("row", { name: /Disable me/ })).toHaveCount(0);
});

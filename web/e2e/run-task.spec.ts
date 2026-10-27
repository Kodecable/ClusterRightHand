import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

test.beforeEach(async ({ adminPage: page, env }) => {
	await page.goto(`/#/nodes/${env?.nodeId}`);
	await expect(page.getByRole("heading", { name: "Run" })).toBeVisible();
});

test("runs a shell command and shows stdout, stderr and the exit code", async ({ adminPage: page }) => {
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo hello; echo oops >&2; exit 3");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	const result = page.locator(".task-result");
	await expect(result.getByText("exited")).toBeVisible();
	await expect(result.getByText("Exit code")).toBeVisible();
	await expect(result.locator("dd", { hasText: /^3$/ })).toBeVisible();
	await expect(result.getByRole("region", { name: /stdout/ })).toContainText("hello");
	await expect(result.getByRole("region", { name: /stderr/ })).toContainText("oops");
});

test("cancels a running task from the UI", async ({ adminPage: page }) => {
	await page.getByRole("textbox", { name: "Shell command" }).fill("sleep 30");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await page.getByRole("button", { name: "Cancel" }).click();
	const result = page.locator(".task-result");
	await expect(result.getByText("cancelled")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
});

test("a task with a short timeout shows timed out", async ({ adminPage: page }) => {
	await page.getByLabel("Timeout (s)").fill("1");
	await page.getByRole("textbox", { name: "Shell command" }).fill("sleep 30");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.locator(".task-result").getByText("timed out")).toBeVisible({ timeout: 20_000 });
});

test("finished tasks are listed on the node page and open on their own page", async ({ adminPage: page, env }) => {
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo listed-task");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.locator(".task-result").getByText("exited")).toBeVisible();
	const row = page.getByRole("row").filter({ hasText: "echo listed-task" });
	await expect(row).toBeVisible();
	await expect(row.getByText("exit 0")).toBeVisible();
	await row.getByRole("link", { name: "Details" }).click();
	await expect(page.getByRole("heading", { name: "Task" })).toBeVisible();
	await expect(page.locator(".task-result").getByRole("region", { name: /stdout/ })).toContainText("listed-task");
	await page.getByRole("link", { name: "← Node" }).click();
	await expect(page).toHaveURL(new RegExp(`#/nodes/${env?.nodeId}$`));
});

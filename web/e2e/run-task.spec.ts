import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

test.beforeEach(async ({ adminPage: page, env }) => {
	await page.goto(`/nodes/${env?.nodeId}`);
	await expect(page.getByRole("heading", { name: "Run a task" })).toBeVisible();
});

/** The run panel's result of the latest task. */
function taskResult(page: import("@playwright/test").Page) {
	return page.locator('[data-slot="task-result"]');
}

test("runs a shell command and shows its merged output and the exit code", async ({ adminPage: page }) => {
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo hello; echo oops >&2; exit 3");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	const result = taskResult(page);
	// A non-zero exit is flagged, not shown like a success.
	await expect(result.getByText("Finished", { exact: true })).toBeVisible({ timeout: 20_000 });
	await expect(result.getByText("Exit code")).toBeVisible();
	await expect(result.locator("dd", { hasText: /^3$/ })).toBeVisible();
	// The task output is one stream (D114): stdout and stderr arrive together.
	const output = result.getByRole("region", { name: "output", exact: true });
	await expect(output).toHaveCount(1);
	await expect(output).toContainText("hello");
	await expect(output).toContainText("oops");
	await expect(result.getByRole("region", { name: /stderr/ })).toHaveCount(0);
});

test("cancels a running task from the UI", async ({ adminPage: page }) => {
	await page.getByRole("textbox", { name: "Shell command" }).fill("sleep 30");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await page.getByRole("button", { name: "Cancel task" }).click();
	const result = taskResult(page);
	await expect(result.getByText("Finished", { exact: true })).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("button", { name: "Cancel task" })).toHaveCount(0);
	// The node's task list names the outcome the result keeps out of its key/value block.
	await expect(page.getByTestId("node-tasks").getByRole("row").filter({ hasText: "sleep 30" })).toContainText(
		"Cancelled",
		{ timeout: 20_000 },
	);
});

test("a task with a short timeout shows timed out", async ({ adminPage: page }) => {
	await page.getByLabel("Timeout (s)").fill("1");
	await page.getByRole("textbox", { name: "Shell command" }).fill("sleep 30");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(taskResult(page).getByText("Finished", { exact: true })).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId("node-tasks").getByRole("row").filter({ hasText: "sleep 30" })).toContainText(
		"Timed out",
		{ timeout: 20_000 },
	);
});

test("finished tasks are listed on the node page and open on their own page", async ({ adminPage: page, env }) => {
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo listed-task");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(taskResult(page).getByText("Finished", { exact: true })).toBeVisible({ timeout: 20_000 });
	const row = page.getByRole("row").filter({ hasText: "echo listed-task" });
	await expect(row).toBeVisible({ timeout: 20_000 });
	await expect(row.getByText("Exit code 0")).toBeVisible();
	await row.getByRole("link", { name: "Open task" }).click();
	await expect(page.getByTestId("task-page")).toBeVisible();
	await expect(page.getByTestId("task-page")).toContainText("listed-task");
	// The node link shows the node's name (not its id) but still points at the node.
	const nodeLink = page.getByTestId("task-page").locator(`a[href="/nodes/${env?.nodeId}"]`);
	await expect(nodeLink).toBeVisible();
	await expect(nodeLink).not.toHaveText(env?.nodeId ?? "");
	await nodeLink.click();
	await expect(page).toHaveURL(new RegExp(`/nodes/${env?.nodeId}$`));
});

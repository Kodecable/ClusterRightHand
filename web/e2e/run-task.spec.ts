import type { Page } from "@playwright/test";
import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

/** Opens the tasks page's "Run task" dialog. */
async function openRunTask(page: Page): Promise<void> {
	await page.goto("/tasks");
	await page.getByTestId("run-task").click();
	await expect(page.getByRole("dialog", { name: "Run task" })).toBeVisible();
}

/** Picks the only enrolled node by name in the dialog's merged node / node-group picker. */
async function pickOnlyNode(page: Page, crhs: InProcessCrhs): Promise<string> {
	const { json } = await crhs.api("/api/nodes");
	const name: string = json.nodes[0].name;
	await page.getByRole("combobox", { name: "Nodes or node groups" }).click();
	// A node option reads "<name> <hostname> Node"; a node group with a similar name ends in "Node group".
	await page.getByRole("option", { name: new RegExp(`^${name} .*Node$`) }).click();
	await page.keyboard.press("Escape");
	return name;
}

test("runs a shell command and shows its merged output and the exit code", async ({ adminPage: page, crhs }) => {
	await openRunTask(page);
	await pickOnlyNode(page, crhs);
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo hello; echo oops >&2; exit 3");
	await page.getByRole("button", { name: "Run", exact: true }).click();

	await expect(page.getByTestId("task-page")).toBeVisible();
	// The header carries the outcome: Finished alone would hide a non-zero exit.
	await expect(page.getByTestId("task-outcome")).toHaveText("Exit code 3", { timeout: 20_000 });
	// The task output is one stream (D114): stdout and stderr arrive together.
	const output = page.getByTestId("task-page").getByRole("region", { name: "output", exact: true });
	await expect(output).toHaveCount(1);
	await expect(output).toContainText("hello");
	await expect(output).toContainText("oops");
	await expect(page.getByTestId("task-page").getByRole("region", { name: /stderr/ })).toHaveCount(0);
});

test("cancels a running task from the UI", async ({ adminPage: page, crhs }) => {
	await openRunTask(page);
	await pickOnlyNode(page, crhs);
	await page.getByRole("textbox", { name: "Shell command" }).fill("sleep 30");
	await page.getByRole("button", { name: "Run", exact: true }).click();

	await expect(page.getByTestId("task-page")).toBeVisible();
	await page.getByTestId("cancel-task").click();
	await expect(page.getByTestId("task-page").getByText("Finished", { exact: true })).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId("task-outcome")).toHaveText("Cancelled", { timeout: 20_000 });
	await expect(page.getByTestId("cancel-task")).toHaveCount(0);
});

test("a task with a short timeout shows timed out", async ({ adminPage: page, crhs }) => {
	await openRunTask(page);
	await pickOnlyNode(page, crhs);
	await page.getByLabel("Timeout (s)").fill("1");
	await page.getByRole("textbox", { name: "Shell command" }).fill("sleep 30");
	await page.getByRole("button", { name: "Run", exact: true }).click();

	await expect(page.getByTestId("task-page").getByText("Finished", { exact: true })).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId("task-outcome")).toHaveText("Timed out", { timeout: 20_000 });
});

test("finished tasks are listed on the node page and open on their own page", async ({
	adminPage: page,
	crhs,
	env,
}) => {
	await openRunTask(page);
	await pickOnlyNode(page, crhs);
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo listed-task");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByTestId("task-page")).toBeVisible();

	await page.goto(`/nodes/${env?.nodeId}`);
	const row = page.getByRole("row").filter({ hasText: "echo listed-task" });
	await expect(row).toBeVisible({ timeout: 20_000 });
	await expect(row.getByText("Exit code 0")).toBeVisible();
	await row.getByRole("link", { name: "echo listed-task" }).click();
	await expect(page.getByTestId("task-page")).toBeVisible();
	await expect(page.getByTestId("task-page")).toContainText("listed-task");
	// The node link shows the node's name (not its id) but still points at the node.
	const nodeLink = page.getByTestId("task-page").locator(`a[href="/nodes/${env?.nodeId}"]`);
	await expect(nodeLink).toBeVisible();
	await expect(nodeLink).not.toHaveText(env?.nodeId ?? "");
	await nodeLink.click();
	await expect(page).toHaveURL(new RegExp(`/nodes/${env?.nodeId}$`));
});

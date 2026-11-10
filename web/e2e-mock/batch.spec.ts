import { expect, test } from "@playwright/test";
import { login, mockApi, nodeView } from "./helpers";

/** Opens the tasks page's "Run task" dialog. */
async function openRunTask(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/tasks");
	await page.getByTestId("run-task").click();
	await expect(page.getByRole("dialog", { name: "Run task" })).toBeVisible();
}

test("a batch run fills the per-node grid as the tasks finish", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			nodes: [
				nodeView({ id: "node-1", name: "worker-01" }),
				nodeView({ id: "node-2", name: "worker-02", hostname: "worker-02.local" }),
			],
		},
	});
	await login(page);
	await openRunTask(page);

	await page.getByRole("combobox", { name: "Nodes or node groups" }).click();
	await page.getByRole("option", { name: /worker-01/ }).click();
	await page.getByRole("option", { name: /worker-02/ }).click();
	await page.keyboard.press("Escape");

	await page.locator('input[id$="-command"]').fill("uname -a");
	await page.getByRole("button", { name: "Run", exact: true }).click();

	await expect(page.getByTestId("task-group-page")).toBeVisible();
	await expect(page.getByTestId("task-group-member")).toHaveCount(2);
	await expect(page.locator('[data-testid="task-group-member"]').first()).toContainText("worker-01");

	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/task-groups");
	expect(created?.body).toMatchObject({ targets: ["worker-01", "worker-02"], shell: "uname -a", waitMs: 0 });

	// The group is polled; the fake finishes it on the second fetch.
	await expect
		.poll(async () => (await page.getByTestId("task-group-member").first().textContent()) ?? "", { timeout: 15_000 })
		.toContain("Finished");
	await expect(page.getByText("Finished").first()).toBeVisible();
});

test("all accessible nodes sends _all", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			nodes: [
				nodeView({ id: "node-1", name: "worker-01" }),
				nodeView({ id: "node-2", name: "worker-02", hostname: "worker-02.local" }),
			],
		},
	});
	await login(page);
	await openRunTask(page);

	await page.getByRole("checkbox", { name: "All nodes I can access" }).check();
	await page.locator('input[id$="-command"]').fill("uptime");
	await page.getByRole("button", { name: "Run", exact: true }).click();

	await expect(page.getByTestId("task-group-page")).toBeVisible();
	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/task-groups");
	expect(created?.body).toMatchObject({ targets: ["_all"] });
});

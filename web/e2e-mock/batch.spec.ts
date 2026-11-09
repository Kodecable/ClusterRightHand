import { expect, test } from "@playwright/test";
import { login, mockApi, nodeView } from "./helpers";

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
	await page.goto("/batch");
	await expect(page.getByTestId("batch-page")).toBeVisible();

	await page.getByRole("button", { name: /Choose nodes/ }).click();
	await page.getByRole("checkbox", { name: /worker-01/ }).check();
	await page.getByRole("checkbox", { name: /worker-02/ }).check();
	await page.keyboard.press("Escape");

	await page.locator('input[id$="-command"]').fill("uname -a");
	await page.getByTestId("batch-run").click();

	await expect(page.getByTestId("batch-result")).toBeVisible();
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
	await page.goto("/batch");
	await expect(page.getByTestId("batch-page")).toBeVisible();

	await page.getByRole("checkbox", { name: "All accessible nodes" }).check();
	await page.locator('input[id$="-command"]').fill("uptime");
	await page.getByTestId("batch-run").click();

	await expect(page.getByTestId("batch-result")).toBeVisible();
	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/task-groups");
	expect(created?.body).toMatchObject({ targets: ["_all"] });
});

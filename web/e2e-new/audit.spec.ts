import { expect, test } from "@playwright/test";
import { auditEvent, login, mockApi } from "./helpers";

test("filter the audit log and load more", async ({ page }) => {
	const audit = Array.from({ length: 60 }, (_, index) =>
		auditEvent({
			id: `evt-${index + 1}`,
			seq: index + 1,
			action: index % 2 === 0 ? "task.approval" : "node.approved",
			targetType: index % 2 === 0 ? "task" : "node",
			targetId: `target-${index + 1}`,
		}),
	);
	const api = await mockApi(page, { state: { audit } });
	await login(page);
	await page.goto("/audit");
	await expect(page.getByTestId("audit-page")).toBeVisible();

	const rows = page.locator('[data-slot="data-table"] [role="rowgroup"] [role="row"]');
	await expect(rows).toHaveCount(50);
	await page.getByRole("button", { name: "Load more" }).click();
	await expect(rows).toHaveCount(60);
	await expect
		.poll(() => api.state.requests.some((request) => request.url.startsWith("/api/audit?cursor=50")))
		.toBe(true);

	await page.getByLabel("Action").fill("task.");
	await page.getByLabel("Target type").fill("task");
	await page.getByRole("button", { name: "Filter" }).click();
	await expect
		.poll(() =>
			api.state.requests.some(
				(request) =>
					request.url.startsWith("/api/audit?") &&
					request.url.includes("action=task.") &&
					request.url.includes("targetType=task"),
			),
		)
		.toBe(true);
	await expect(rows).toHaveCount(30);
});

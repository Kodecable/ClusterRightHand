import { expect, test } from "@playwright/test";
import { emptyApprovals, login, mockApi, nodeView, taskView } from "./helpers";

test("an approval decision from the Approvals page updates the list and the badge", async ({ page }) => {
	const task = taskView({ id: "task-42" });
	const api = await mockApi(page, {
		state: {
			approvals: { ...emptyApprovals(), tasks: [task] },
			tasks: [task],
			nodes: [nodeView()],
		},
	});
	await login(page);
	await expect(page.getByTestId("nav-approvals-badge")).toHaveText("1");

	await page.goto("/approvals");
	await expect(page.getByTestId("approvals-page")).toBeVisible();
	const row = page.getByRole("row").filter({ hasText: "systemctl restart nginx" });
	await expect(row).toContainText("Approval");
	await expect(row).toContainText("worker-01");
	await row.getByRole("link", { name: "systemctl restart nginx" }).click();
	await expect(page).toHaveURL(/\/approvals\/tasks\/task-42$/);

	const decision = page.getByRole("region", { name: "Your approval is needed" });
	await expect(decision).toBeVisible();
	await decision.getByRole("button", { name: "Approve", exact: true }).click();

	await expect
		.poll(() => api.state.requests.some((request) => request.url === "/api/tasks/task-42/approval"))
		.toBe(true);
	const approval = api.state.requests.find((request) => request.url === "/api/tasks/task-42/approval");
	expect(approval?.body).toEqual({ decision: "approve" });

	// The fake server removed the task; the invalidated queries show an empty page and badge.
	await page.goto("/approvals");
	await expect(page.getByText("Nothing is waiting for you")).toBeVisible();
	await expect(page.getByTestId("nav-approvals-badge")).toHaveCount(0);
});

test("the deep link to one approval shows already-settled tasks", async ({ page }) => {
	const settled = taskView({ id: "task-settled", state: "exited", exitCode: 0 });
	await mockApi(page, {
		state: {
			approvals: emptyApprovals(),
			tasks: [settled],
		},
	});
	await login(page);
	await page.goto("/approvals/tasks/task-settled");
	await expect(page.getByTestId("approval-detail")).toBeVisible();
	await expect(page.getByText("Already settled")).toBeVisible();
	await expect(page.getByText("This request is no longer waiting for approval; it is")).toBeVisible();
});

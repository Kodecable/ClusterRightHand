import { expect, test } from "@playwright/test";
import { login, mockApi, nodeView, USER } from "./helpers";

/** One stored authorization: a known node, an unknown one, and one covered task. */
const state = {
	nodes: [nodeView({ id: "node-1", name: "worker-01" })],
	authorizations: [
		{
			id: "auth-1",
			issuerUserId: USER.id,
			issuerUsername: USER.displayName,
			nodes: ["node-1", "node-missing"],
			command: { method: "exec" as const, match: "prefix" as const, target: "systemctl restart " },
			taskIds: ["task-1"],
			attempt: 1,
			note: "",
			issuedAt: "2026-01-01T00:00:00.000Z",
			deadline: "2026-02-01T00:00:00.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	],
};

test.beforeEach(async ({ page }) => {
	await mockApi(page, { state });
});

test("the authorization list resolves node names and falls back to the id", async ({ page }) => {
	await login(page);
	await page.goto("/authorizations");

	const node = page.getByRole("link", { name: "worker-01" });
	await expect(node).toBeVisible();
	await expect(node).toHaveAttribute("href", "/nodes/node-1");
	// A node the directory does not know stays visible as its raw id.
	await expect(page.getByText("node-missing")).toBeVisible();
});

test("the payload dialog links nodes and tasks", async ({ page }) => {
	await login(page);
	await page.goto("/authorizations");
	await page.getByRole("button", { name: "Payload" }).click();

	const dialog = page.getByRole("dialog", { name: "Authorization payload" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("link", { name: "worker-01" })).toHaveAttribute("href", "/nodes/node-1");
	await expect(dialog.getByRole("link", { name: "task-1" })).toHaveAttribute("href", "/tasks/task-1");
	// The unknown node keeps its id, still without a link.
	await expect(dialog.getByText("node-missing")).toBeVisible();
});

test("a member sees the page with only their own list, without the issuer column", async ({ page }) => {
	await page.unroute("**/api/**");
	await mockApi(page, { state, user: { ...USER, kind: "member" } });
	await login(page);
	await page.getByTestId("nav-authorizations").click();
	await expect(page).toHaveURL(/\/authorizations$/);
	await expect(page.getByText("The authorizations you signed.", { exact: false })).toBeVisible();
	await expect(page.getByRole("link", { name: "worker-01" })).toBeVisible();
	await expect(page.getByRole("columnheader", { name: "Issuer" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Issue authorization" })).toBeVisible();
});

test("Issue authorization builds the crhu grant command and submits the pasted line", async ({ page }) => {
	await login(page);
	await page.goto("/authorizations");
	await expect(page.getByRole("columnheader", { name: "Issuer" })).toBeVisible();
	await page.getByRole("button", { name: "Issue authorization" }).click();
	const dialog = page.getByRole("dialog", { name: "Issue authorization" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("Choose at least one node or node group to sign.")).toBeVisible();

	await dialog.getByRole("combobox", { name: "Nodes or node groups" }).click();
	await page.getByRole("option", { name: /worker-01/ }).click();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeVisible();

	const command = dialog.getByTestId("decision-command");
	await expect(command).toHaveAttribute("title", "crhu grant --nodes node-1 --method exec --prefix '' --deadline 24h");
	await dialog.getByLabel("Target prefix").fill("systemctl restart ");
	await expect(command).toHaveAttribute(
		"title",
		"crhu grant --nodes node-1 --method exec --prefix 'systemctl restart ' --deadline 24h",
	);

	await dialog.getByLabel("Signature").fill("signed-grant");
	const submitted = page.waitForRequest(
		(request) => request.url().endsWith("/api/authorizations") && request.method() === "POST",
	);
	await dialog.getByRole("button", { name: "Submit authorization" }).click();
	expect((await submitted).postDataJSON()).toEqual({ authorization: "signed-grant" });
	await expect(dialog).toBeHidden();
});

import { expect, test } from "@playwright/test";
import { login, mockApi } from "./helpers";

test("create an API token once and revoke it", async ({ page }) => {
	const api = await mockApi(page);
	await login(page);
	await page.goto("/tokens");
	await expect(page.getByTestId("tokens-page")).toBeVisible();

	await page.getByTestId("create-token").click();
	const dialog = page.getByTestId("create-token-dialog");
	await expect(dialog).toBeVisible();
	await page.getByLabel("Name").fill("laptop");
	await page.getByRole("button", { name: "Create token" }).click();

	await expect(page.getByText("Copy this token now. It will not be shown again.")).toBeVisible();
	await expect(page.getByText("crh_created_once", { exact: true })).toBeVisible();
	const created = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/api-tokens");
	expect(created?.body).toEqual({ name: "laptop", rulePreset: "ask", days: 90 });

	await page.getByRole("button", { name: "Done" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("table", { name: "API tokens" })).toContainText("laptop");
	// The secret is not part of the list.
	await expect(page.getByText("crh_created_once", { exact: true })).toHaveCount(0);

	await page.getByRole("button", { name: "Revoke" }).click();
	const confirm = page.getByRole("dialog", { name: "Revoke token laptop?" });
	await expect(confirm).toBeVisible();
	await confirm.getByRole("button", { name: "Revoke token" }).click();
	await expect(page.getByText("Token revoked.")).toBeVisible();
	await expect
		.poll(() => api.state.requests.some((request) => request.url === "/api/api-tokens/token-1/revoke"))
		.toBe(true);
	await expect(page.getByRole("table", { name: "API tokens" })).toContainText("Revoked");
});

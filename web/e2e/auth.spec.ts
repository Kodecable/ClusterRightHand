import { ADMIN, expect, login, test } from "./fixtures.ts";

test("logs in through the form and logs out", async ({ page }) => {
	await login(page);
	await expect(page.getByTestId("app-sidebar")).toContainText(ADMIN.username);
	await expect(page.getByTestId("page-title")).toHaveText("Sessions");
	await page.getByTestId("user-menu-trigger").click();
	await page.getByTestId("menu-logout").click();
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
	// The session is really gone: a reload stays on the login form.
	await page.reload();
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("a wrong password shows an error and stays on the login form", async ({ page }) => {
	await login(page, { username: ADMIN.username, password: "not-the-password" });
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
	await expect(page.getByTestId("page-title")).toHaveCount(0);
});

test("changes the own password, then only the new one works", async ({ page }) => {
	const next = "a-new-password-42";
	await login(page);
	await page.getByTestId("user-menu-trigger").click();
	await page.getByTestId("menu-change-password").click();
	const dialog = page.getByRole("dialog", { name: "Change password" });
	await dialog.getByLabel("Current password").fill(ADMIN.password);
	await dialog.getByLabel("New password", { exact: true }).fill(next);
	await dialog.getByLabel("Repeat new password").fill(next);
	await dialog.getByRole("button", { name: "Save password" }).click();
	await expect(page.getByText("Password changed.")).toBeVisible();
	await expect(dialog).toBeHidden();
	await page.getByTestId("user-menu-trigger").click();
	await page.getByTestId("menu-logout").click();
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

	await login(page, { username: ADMIN.username, password: ADMIN.password });
	await expect(page.getByRole("alert")).toBeVisible();
	await login(page, { username: ADMIN.username, password: next });
	await expect(page.getByTestId("page-title")).toHaveText("Sessions");
});

test("mismatching new passwords are rejected in the dialog", async ({ adminPage: page }) => {
	await page.goto("/");
	await page.getByTestId("user-menu-trigger").click();
	await page.getByTestId("menu-change-password").click();
	const dialog = page.getByRole("dialog", { name: "Change password" });
	await dialog.getByLabel("Current password").fill(ADMIN.password);
	await dialog.getByLabel("New password", { exact: true }).fill("first-password-1");
	await dialog.getByLabel("Repeat new password").fill("second-password-2");
	await dialog.getByRole("button", { name: "Save password" }).click();
	await expect(dialog.getByText("The new passwords do not match.")).toBeVisible();
});

test("a deep link to an approval survives the sign-in form", async ({ page }) => {
	// An MCP approval URL is a path now (doc/webui.md "路由"); the login page keeps it in `redirect`.
	await page.goto("/approvals/tasks/task-from-mcp");
	await expect(page).toHaveURL(/\/login\?redirect=/);
	await page.getByLabel("Username").fill(ADMIN.username);
	await page.getByLabel("Password").fill(ADMIN.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(/\/approvals\/tasks\/task-from-mcp$/);
	await expect(page.getByTestId("page-title")).toHaveText("Approvals");
});

test("an old hash link becomes a path", async ({ page }) => {
	await page.goto("/#/approvals");
	await expect(page).toHaveURL(/\/login\?redirect=/);
	await page.getByLabel("Username").fill(ADMIN.username);
	await page.getByLabel("Password").fill(ADMIN.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(/\/approvals$/);
	await expect(page.getByTestId("page-title")).toHaveText("Approvals");
});

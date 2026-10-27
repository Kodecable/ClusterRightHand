import { ADMIN, expect, login, test } from "./fixtures.ts";

test("logs in through the form and logs out", async ({ page }) => {
	await login(page);
	await expect(page.getByText(ADMIN.username)).toBeVisible();
	await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible();
	await page.getByRole("button", { name: "Log out" }).click();
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
	// The session is really gone: a reload stays on the login form.
	await page.reload();
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("a wrong password shows an error and stays on the login form", async ({ page }) => {
	await login(page, { username: ADMIN.username, password: "not-the-password" });
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);
});

test("changes the own password, then only the new one works", async ({ page }) => {
	const next = "a-new-password-42";
	await login(page);
	await page.getByRole("button", { name: "Change password" }).click();
	const dialog = page.getByRole("dialog", { name: "Change password" });
	await dialog.getByLabel("Current password").fill(ADMIN.password);
	await dialog.getByLabel("New password", { exact: true }).fill(next);
	await dialog.getByLabel("Repeat new password").fill(next);
	await dialog.getByRole("button", { name: "Change", exact: true }).click();
	await expect(dialog.getByText("Password changed.")).toBeVisible();
	await dialog.getByRole("button", { name: "Close" }).click();
	await page.getByRole("button", { name: "Log out" }).click();

	await login(page, { username: ADMIN.username, password: ADMIN.password });
	await expect(page.getByRole("alert")).toBeVisible();
	await login(page, { username: ADMIN.username, password: next });
	await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
});

test("mismatching new passwords are rejected in the dialog", async ({ adminPage: page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Change password" }).click();
	const dialog = page.getByRole("dialog", { name: "Change password" });
	await dialog.getByLabel("Current password").fill(ADMIN.password);
	await dialog.getByLabel("New password", { exact: true }).fill("first-password-1");
	await dialog.getByLabel("Repeat new password").fill("second-password-2");
	await dialog.getByRole("button", { name: "Change", exact: true }).click();
	await expect(dialog.getByRole("alert")).toHaveText("the new passwords do not match");
});

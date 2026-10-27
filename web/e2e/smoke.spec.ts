import { ADMIN, expect, login, test } from "./fixtures.ts";

test("logs in through the form", async ({ page }) => {
	await login(page);
	await expect(page.getByText(ADMIN.username)).toBeVisible();
});

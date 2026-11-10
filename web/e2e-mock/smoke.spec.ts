import { expect, test } from "@playwright/test";
import { login, mockApi, openMenuSection, openUserMenuWithKeyboard, USER } from "./helpers";

test.beforeEach(async ({ page }) => {
	await mockApi(page);
});

test("logs in and sees the shell with the approvals badge", async ({ page }) => {
	await login(page);
	await expect(page.getByTestId("app-sidebar")).toBeVisible();
	await expect(page.getByTestId("nav-sessions")).toBeVisible();
	await expect(page.getByTestId("nav-approvals-badge")).toHaveText("2");
	await expect(page.getByTestId("session-list-slot")).toBeVisible();
});

test("only authorizations and schedules keep a page header description", async ({ page }) => {
	await login(page);
	for (const path of [
		"/approvals",
		"/tasks",
		"/nodes",
		"/credentials",
		"/audit",
		"/settings/models",
		"/tokens",
		"/users",
	]) {
		await page.goto(path);
		const header = page.locator('[data-slot="page-header"]');
		await expect(header).toBeVisible();
		await expect(header.locator("p")).toHaveCount(0);
	}
	for (const path of ["/authorizations", "/schedules"]) {
		await page.goto(path);
		await expect(page.locator('[data-slot="page-header"] p').first()).toBeVisible();
	}
});

test("the old batch route redirects to the tasks page", async ({ page }) => {
	await login(page);
	await page.goto("/batch");
	await expect(page).toHaveURL(/\/tasks$/);
	await expect(page.getByTestId("tasks-page")).toBeVisible();
});

test("a deep link survives login", async ({ page }) => {
	await page.goto("/approvals/tasks/task-1");
	await expect(page).toHaveURL(/\/login\?redirect=/);
	await page.getByLabel("Username").fill("ops");
	await page.getByLabel("Password").fill("secret");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(/\/approvals\/tasks\/task-1$/);
	await expect(page.getByTestId("page-title")).toHaveText("Approvals");
});

test("legacy hash links become paths", async ({ page }) => {
	await page.goto("/#/tasks/task-1");
	await expect(page).toHaveURL(/\/login\?redirect=/);
	await page.getByLabel("Username").fill("ops");
	await page.getByLabel("Password").fill("secret");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(/\/tasks\/task-1$/);
});

test("collapsing the sidebar persists across a reload and shows tooltips", async ({ page }) => {
	await login(page);
	const sidebar = page.locator('[data-slot="sidebar"]');
	await expect(sidebar).toHaveAttribute("data-state", "expanded");

	await page.getByTestId("sidebar-trigger").click();
	await expect(sidebar).toHaveAttribute("data-state", "collapsed");
	expect(await page.evaluate(() => window.localStorage.getItem("crh.sidebar.open"))).toBe("false");

	await page.reload();
	await expect(page.getByTestId("page-title")).toHaveText("Sessions");
	await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute("data-state", "collapsed");

	await page.getByTestId("nav-sessions").hover();
	await expect(page.locator('[data-slot="tooltip-content"]:visible').filter({ hasText: "Sessions" })).toBeVisible();
});

test("theme and language switch without reloading the app", async ({ page }) => {
	await login(page);
	await openUserMenuWithKeyboard(page);
	await openMenuSection(page, "menu-theme");
	await page.getByTestId("theme-dark").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	expect(await page.evaluate(() => window.localStorage.getItem("crh.theme"))).toBe("dark");

	// The menu stays open after a radio choice; the language submenu is next to
	// the theme one, so switch to it in place instead of reopening the menu.
	await openMenuSection(page, "menu-language");
	await page.getByTestId("language-zh").click();
	await expect(page.getByTestId("page-title")).toHaveText("会话");
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
	expect(await page.evaluate(() => window.__crhAppMounts)).toBe(1);
});

test("the user menu opens from the keyboard and closes on Escape", async ({ page }) => {
	await login(page);
	await openUserMenuWithKeyboard(page);
	await page.keyboard.press("ArrowDown");
	await expect(page.locator('[role="menuitem"]:focus')).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("user-menu")).toBeHidden();
	// Focus returns to the trigger.
	await expect(page.getByTestId("user-menu-trigger")).toBeFocused();
});

test("the change-password dialog traps Tab and validates the form", async ({ page }) => {
	await login(page);
	await openUserMenuWithKeyboard(page);
	await page.getByTestId("menu-change-password").click();
	const dialog = page.getByRole("dialog", { name: "Change password" });
	await expect(dialog).toBeVisible();

	// Base UI's documented Tab loop. Its focus guards hand focus back to the
	// first/last control in the next animation frame. Poll for focus to settle
	// inside the dialog instead of sleeping a fixed delay: a slow frame under a
	// loaded worker would otherwise see the guard itself and fail.
	for (let i = 0; i < 8; i += 1) {
		await page.keyboard.press("Tab");
		await expect
			.poll(
				() =>
					page.evaluate(() => {
						const element = document.querySelector('[role="dialog"]');
						return element?.contains(document.activeElement) === true;
					}),
				{ message: `after tab ${i + 1}` },
			)
			.toBe(true);
	}

	await page.getByRole("button", { name: "Save password" }).click();
	await expect(page.getByText("Enter your current password.")).toBeVisible();
	await expect(page.getByText("Use at least 8 characters.")).toBeVisible();

	await page.getByLabel("Current password").fill("old-password");
	await page.getByLabel("New password", { exact: true }).fill("new-password-1");
	await page.getByLabel("Repeat new password").fill("different");
	await page.getByRole("button", { name: "Save password" }).click();
	await expect(page.getByText("The new passwords do not match.")).toBeVisible();

	await page.getByLabel("Repeat new password").fill("new-password-1");
	await page.getByRole("button", { name: "Save password" }).click();
	await expect(dialog).toBeHidden();
});

test("admin-only routes redirect a non-admin", async ({ page }) => {
	await page.unroute("**/api/**");
	await mockApi(page, { user: { ...USER, kind: "member" } });
	await login(page);
	await page.goto("/users");
	await expect(page).toHaveURL(/\/sessions$/);
	await page.goto("/settings/models");
	await expect(page).toHaveURL(/\/sessions$/);
});

test("the mobile drawer opens below 768 px and closes on Escape", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await login(page);

	const desktopSidebar = page.locator('[data-slot="sidebar"]');
	await expect(desktopSidebar).toBeHidden();

	await page.getByTestId("sidebar-trigger").click();
	const drawer = page.getByRole("dialog", { name: "Sidebar" });
	await expect(drawer).toBeVisible();
	await expect(page.getByTestId("nav-sessions")).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
});

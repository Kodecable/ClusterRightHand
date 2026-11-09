import { expect, test } from "@playwright/test";
import { login, mockApi, userGroup } from "./helpers";

test("create a user and add them to a group", async ({ page }) => {
	const api = await mockApi(page, { state: { userGroups: [userGroup({ name: "Ops" })] } });
	await login(page);
	await page.goto("/users");
	await expect(page.getByTestId("users-page")).toBeVisible();

	await page.getByTestId("new-user").click();
	const dialog = page.getByRole("dialog", { name: "New user" });
	await expect(dialog).toBeVisible();
	await page.getByLabel("Username").fill("alice");
	await page.getByLabel("Display name").fill("Alice");
	await page.getByRole("button", { name: "Create user" }).click();
	await expect(page.getByRole("table", { name: "Users" })).toContainText("alice");

	const group = page.getByTestId("user-group-card").filter({ hasText: "Ops" });
	await expect(group).toBeVisible();
	await group.getByLabel("Add member").click();
	await page.getByRole("option", { name: "alice" }).click();
	await group.getByRole("button", { name: "Add" }).click();
	await expect(group.getByRole("list", { name: "Members of Ops" })).toContainText("alice");
	await expect
		.poll(() =>
			api.state.requests.some(
				(request) =>
					request.method === "PUT" && request.url === `/api/user-groups/group-1/members/${api.state.users[0]?.id}`,
			),
		)
		.toBe(true);
});

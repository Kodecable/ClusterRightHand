import { expect, test } from "@playwright/test";
import { login, mockApi } from "./helpers";

test("create a user and add them to a group", async ({ page }) => {
	const api = await mockApi(page);
	await login(page);
	await page.goto("/users");
	await expect(page.getByTestId("users-page")).toBeVisible();

	await page.getByTestId("new-user").click();
	const dialog = page.getByRole("dialog", { name: "New user" });
	await expect(dialog).toBeVisible();
	await page.getByLabel("Username").fill("alice");
	await page.getByLabel("Display name").fill("Alice");
	await dialog.getByRole("button", { name: "New user" }).click();
	await expect(page.getByRole("table", { name: "Users" })).toContainText("alice");

	// The row links to the user page; its own name stays plain text.
	await expect(page.getByRole("link", { name: "alice" })).toHaveAttribute("href", /\/users\/user-/);

	// Node access is on the detail page, never a column with edit controls in the list.
	await expect(page.getByRole("columnheader", { name: "Node access" })).toHaveCount(0);
	await page.getByRole("link", { name: "alice" }).click();
	await expect(page.getByTestId("user-detail")).toBeVisible();
	await expect(page.getByTestId("grantee-node-access")).toContainText("No node access");
	await page.goto("/users");

	// Groups are a read-only table; creating one opens the name dialog.
	await page.getByTestId("create-user-group").click();
	const groupDialog = page.getByRole("dialog", { name: "New user group" });
	await groupDialog.getByLabel("User group name").fill("Ops");
	await groupDialog.getByRole("button", { name: "New user group" }).click();
	await expect(page.getByRole("table", { name: "User groups" })).toContainText("Ops");

	// Membership is edited on the group page, not in a card on the users page.
	await page.getByRole("link", { name: "Ops", exact: true }).click();
	await expect(page.getByTestId("user-group-detail")).toBeVisible();
	await expect(page.getByTestId("grantee-node-access")).toContainText("No node access");
	const group = page.getByTestId("user-group-members");
	await group.getByLabel("Add member").click();
	await page.getByRole("option", { name: "alice" }).click();
	await group.getByRole("button", { name: "Add", exact: true }).click();
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

import type { Page } from "@playwright/test";
import { expect, login, test } from "./fixtures.ts";

test.use({ withNode: true });

const MEMBER = { username: "mallory", password: "member-password-1" };

async function addedMemberShowsUp(page: Page, label: string): Promise<void> {
	// Members show their display name (the username when they have none), like every other user reference.
	const group = page.getByTestId("user-group-members");
	await expect(group.getByRole("list", { name: "Members of ops" })).toContainText(label);
}

/** Create a user group from the users page and open its detail page. */
async function openNewGroup(page: Page, name: string): Promise<void> {
	await page.getByTestId("create-user-group").click();
	const dialog = page.getByRole("dialog", { name: "New user group" });
	await dialog.getByLabel("User group name").fill(name);
	await dialog.getByRole("button", { name: "Create user group" }).click();
	await page.getByRole("link", { name, exact: true }).click();
	await expect(page.getByTestId("user-group-detail")).toBeVisible();
}

test("admin grants node access; removing it hides the node again", async ({ adminPage: page, browser, crhs, env }) => {
	const nodeId = env?.nodeId as string;
	const { json } = await crhs.api("/api/nodes");
	const nodeName: string = json.nodes[0].name;

	// Admin: create a member user and a user group containing it.
	await page.goto("/users");
	await page.getByTestId("new-user").click();
	const dialog = page.getByRole("dialog", { name: "New user" });
	await dialog.getByLabel("Username").fill(MEMBER.username);
	await dialog.getByLabel("Display name").fill("Mallory M");
	await dialog.getByLabel("Password", { exact: true }).fill(MEMBER.password);
	await dialog.getByRole("button", { name: "Create user" }).click();
	const userRow = page.getByRole("row").filter({ hasText: MEMBER.username });
	await expect(userRow).toBeVisible();
	// The list has no inline edits; the kind is plain text and the row links to the user page.
	await expect(userRow).toContainText("Member");
	await expect(userRow.getByLabel(`Kind of ${MEMBER.username}`)).toHaveCount(0);
	await expect(page.getByRole("link", { name: MEMBER.username })).toHaveAttribute("href", /\/users\/[0-9a-f-]{36}$/);

	await openNewGroup(page, "ops");
	const group = page.getByTestId("user-group-members");
	await group.getByLabel("Add member").click();
	await page.getByRole("option", { name: MEMBER.username }).click();
	await group.getByRole("button", { name: "Add", exact: true }).click();
	await addedMemberShowsUp(page, "Mallory M");

	// Member in a separate browser context: sees no node and no administrator actions.
	const ctx = await browser.newContext({ baseURL: crhs.url });
	try {
		const mp = await ctx.newPage();
		await login(mp, MEMBER);
		await expect(mp.getByTestId("page-title")).toHaveText("Sessions");
		await mp.getByTestId("nav-nodes").click();
		await expect(mp.getByText("An administrator grants access to nodes.")).toBeVisible();
		await expect(mp.getByTestId("add-node")).toHaveCount(0);
		await expect(mp.getByTestId("add-ssh-node")).toHaveCount(0);
		await expect(mp.getByTestId("nav-users")).toHaveCount(0);

		// Admin grants access on the node page: one level, so the member can run at once.
		await page.goto(`/nodes/${nodeId}`);
		const access = page.getByTestId("node-access");
		await access.getByTestId("add-access").click();
		const add = page.getByTestId("add-access-dialog");
		await add.getByLabel("User").click();
		await page.getByRole("option", { name: MEMBER.username }).click();
		await add.getByRole("button", { name: "Add access" }).click();
		await expect(access.getByRole("table", { name: `Access grants for ${nodeName}` })).toContainText(MEMBER.username);

		// The grant shows on the user's detail page, not in a users list row.
		await page.goto("/users");
		await page.getByRole("link", { name: MEMBER.username }).click();
		await expect(page.getByTestId("grantee-node-access")).toContainText(nodeName);

		// Member sees the node and may run tasks; the access section itself stays admin-only.
		// The node list polls, so the new grant shows up without a refresh.
		await expect(mp.getByRole("link", { name: nodeName, exact: true })).toBeVisible({ timeout: 15_000 });
		await mp.getByRole("link", { name: nodeName, exact: true }).click();
		await expect(mp.getByRole("heading", { name: nodeName, exact: true })).toBeVisible();
		await expect(mp.getByTestId("node-access")).toHaveCount(0);
		await expect(mp.getByRole("heading", { name: "Run a task" })).toBeVisible();
		await mp.getByRole("textbox", { name: "Shell command" }).fill("echo member-ran");
		await mp.getByRole("button", { name: "Run", exact: true }).click();
		await expect(
			mp.locator('[data-slot="task-result"]').getByRole("region", { name: "output", exact: true }),
		).toContainText("member-ran", { timeout: 20_000 });

		// Removing the grant hides the node again (404 when accessed by id).
		await page.goto(`/nodes/${nodeId}`);
		await page.getByRole("button", { name: `Remove access for ${MEMBER.username}` }).click();
		await page.getByRole("dialog").getByRole("button", { name: "Remove access" }).click();
		await expect(page.getByText("No access grants yet.")).toBeVisible();
		const denied = await mp.request.post(`/api/nodes/${nodeId}/tasks`, { data: { kind: "exec", shell: "true" } });
		expect(denied.status()).toBe(404);
		// The member is on the node page; their node list no longer has it.
		await mp.goto("/nodes");
		await expect(mp.getByText("An administrator grants access to nodes.")).toBeVisible({ timeout: 15_000 });
	} finally {
		await ctx.close();
	}
});

test("a grant to a user group gives its members access", async ({ adminPage: page, browser, crhs, env }) => {
	const nodeId = env?.nodeId as string;
	const { json } = await crhs.api("/api/nodes");
	const nodeName: string = json.nodes[0].name;
	await crhs.api("/api/users", { body: { username: MEMBER.username, kind: "member", password: MEMBER.password } });
	await page.goto("/users");
	await openNewGroup(page, "ops");
	const group = page.getByTestId("user-group-members");
	await group.getByLabel("Add member").click();
	await page.getByRole("option", { name: MEMBER.username }).click();
	await group.getByRole("button", { name: "Add", exact: true }).click();
	await addedMemberShowsUp(page, MEMBER.username);

	await page.goto(`/nodes/${nodeId}`);
	const access = page.getByTestId("node-access");
	await access.getByTestId("add-access").click();
	const add = page.getByTestId("add-access-dialog");
	await add.getByLabel("Type").click();
	await page.getByRole("option", { name: "User group", exact: true }).click();
	await add.getByLabel("User group").click();
	await page.getByRole("option", { name: "ops" }).click();
	await add.getByRole("button", { name: "Add access" }).click();
	await expect(access.getByRole("table")).toContainText("ops");

	// The group's detail page lists the grant as well.
	await page.goto("/users");
	await page.getByRole("link", { name: "ops", exact: true }).click();
	await expect(page.getByTestId("grantee-node-access")).toContainText(nodeName);

	const ctx = await browser.newContext({ baseURL: crhs.url });
	try {
		const mp = await ctx.newPage();
		await login(mp, MEMBER);
		await expect(mp.getByTestId("page-title")).toHaveText("Sessions");
		await mp.getByTestId("nav-nodes").click();
		await expect(mp.getByRole("row").filter({ hasText: nodeName })).toBeVisible({ timeout: 15_000 });
	} finally {
		await ctx.close();
	}
});

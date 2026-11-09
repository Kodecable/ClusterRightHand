import type { Page } from "@playwright/test";
import { expect, login, test } from "./fixtures.ts";

test.use({ withNode: true });

const MEMBER = { username: "mallory", password: "member-password-1" };

async function addedMemberShowsUp(page: Page): Promise<void> {
	const group = page.getByTestId("user-group-card").filter({ hasText: "ops" });
	await expect(group.getByRole("list", { name: "Members of ops" })).toContainText(MEMBER.username);
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
	await expect(userRow.getByLabel(`Kind of ${MEMBER.username}`)).toContainText("Member");

	await page.getByLabel("User group name").fill("ops");
	await page.getByRole("button", { name: "Create user group" }).click();
	const group = page.getByTestId("user-group-card").filter({ hasText: "ops" });
	await expect(group).toBeVisible();
	await group.getByLabel("Add member").click();
	await page.getByRole("option", { name: MEMBER.username }).click();
	await group.getByRole("button", { name: "Add", exact: true }).click();
	await addedMemberShowsUp(page);

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

		// The grant shows on the users page too.
		await page.goto("/users");
		await expect(page.getByRole("row").filter({ hasText: MEMBER.username })).toContainText(nodeName);

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
	await page.getByLabel("User group name").fill("ops");
	await page.getByRole("button", { name: "Create user group" }).click();
	const group = page.getByTestId("user-group-card").filter({ hasText: "ops" });
	await group.getByLabel("Add member").click();
	await page.getByRole("option", { name: MEMBER.username }).click();
	await group.getByRole("button", { name: "Add", exact: true }).click();
	await addedMemberShowsUp(page);

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

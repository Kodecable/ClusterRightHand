import type { Page } from "@playwright/test";
import { expect, login, test } from "./fixtures.ts";

test.use({ withNode: true });

const MEMBER = { username: "mallory", password: "member-password-1" };

async function addedMemberShowsUp(page: Page): Promise<void> {
	const group = page.getByTestId("group-card").filter({ hasText: "ops" });
	await expect(group.getByRole("list", { name: "Members of ops" })).toContainText(MEMBER.username);
}

test("admin creates users and groups; sharing controls what a member sees and may run", async ({
	adminPage: page,
	browser,
	crhs,
	env,
}) => {
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

	await page.getByLabel("Group name").fill("ops");
	await page.getByRole("button", { name: "Create group" }).click();
	const group = page.getByTestId("group-card").filter({ hasText: "ops" });
	await expect(group).toBeVisible();
	await group.getByLabel("Add member").click();
	await page.getByRole("option", { name: MEMBER.username }).click();
	await group.getByRole("button", { name: "Add", exact: true }).click();
	await addedMemberShowsUp(page);

	// Member in a separate browser context: sees no node.
	const ctx = await browser.newContext({ baseURL: crhs.url });
	try {
		const mp = await ctx.newPage();
		await login(mp, MEMBER);
		await expect(mp.getByTestId("page-title")).toHaveText("Sessions");
		await mp.getByTestId("nav-nodes").click();
		await expect(mp.getByText("No nodes yet")).toBeVisible();
		await expect(mp.getByTestId("nav-users")).toHaveCount(0);

		// Admin shares the node (view).
		await page.goto(`/nodes/${nodeId}`);
		const shares = page.getByTestId("node-shares");
		await shares.getByLabel("Grantee").click();
		await page.getByRole("option", { name: "Mallory M" }).click();
		await shares.getByRole("combobox", { name: "Access" }).click();
		await page.getByRole("option", { name: "View", exact: true }).click();
		await shares.getByRole("button", { name: "Add share" }).click();
		await expect(shares.getByRole("table", { name: "Node shares" })).toContainText("view");

		// Member sees the node but gets no run panel.
		await mp.getByRole("button", { name: "Refresh" }).click();
		await expect(mp.getByRole("link", { name: nodeName })).toBeVisible({ timeout: 15_000 });
		await mp.getByRole("link", { name: nodeName }).click();
		await expect(mp.getByRole("heading", { name: nodeName })).toBeVisible();
		await expect(mp.getByRole("heading", { name: "Run a task" })).toHaveCount(0);
		await expect(mp.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
		await expect(mp.getByTestId("node-shares")).toHaveCount(0);
		// The API refuses too.
		const denied = await mp.request.post(`/api/nodes/${nodeId}/tasks`, { data: { kind: "exec", shell: "true" } });
		expect(denied.status()).toBe(403);
		expect((await denied.json()).error).toBe("view access only");

		// Admin upgrades the share to operate.
		await shares.getByLabel("Grantee").click();
		await page.getByRole("option", { name: "Mallory M" }).click();
		await shares.getByRole("combobox", { name: "Access" }).click();
		await page.getByRole("option", { name: "Operate", exact: true }).click();
		await shares.getByRole("button", { name: "Add share" }).click();
		await expect(shares.getByRole("table", { name: "Node shares" })).toContainText("operate");

		// Member can now run a task.
		await mp.reload();
		await expect(mp.getByRole("heading", { name: "Run a task" })).toBeVisible();
		await mp.getByRole("textbox", { name: "Shell command" }).fill("echo member-ran");
		await mp.getByRole("button", { name: "Run", exact: true }).click();
		await expect(mp.locator('[data-slot="task-result"]').getByRole("region", { name: /stdout/ })).toContainText(
			"member-ran",
			{ timeout: 20_000 },
		);
	} finally {
		await ctx.close();
	}
});

test("a share to a user group gives its members access", async ({ adminPage: page, browser, crhs, env }) => {
	const nodeId = env?.nodeId as string;
	await crhs.api("/api/users", { body: { username: MEMBER.username, kind: "member", password: MEMBER.password } });
	await page.goto("/users");
	await page.getByLabel("Group name").fill("ops");
	await page.getByRole("button", { name: "Create group" }).click();
	const group = page.getByTestId("group-card").filter({ hasText: "ops" });
	await group.getByLabel("Add member").click();
	await page.getByRole("option", { name: MEMBER.username }).click();
	await group.getByRole("button", { name: "Add", exact: true }).click();
	await addedMemberShowsUp(page);

	await page.goto(`/nodes/${nodeId}`);
	const shares = page.getByTestId("node-shares");
	await shares.getByLabel("Type").click();
	await page.getByRole("option", { name: "Group", exact: true }).click();
	await shares.getByLabel("Grantee").click();
	await page.getByRole("option", { name: "ops" }).click();
	await shares.getByRole("combobox", { name: "Access" }).click();
	await page.getByRole("option", { name: "Operate", exact: true }).click();
	await shares.getByRole("button", { name: "Add share" }).click();
	await expect(shares.getByRole("table", { name: "Node shares" })).toContainText("ops");

	const ctx = await browser.newContext({ baseURL: crhs.url });
	try {
		const mp = await ctx.newPage();
		await login(mp, MEMBER);
		await expect(mp.getByTestId("page-title")).toHaveText("Sessions");
		await mp.getByTestId("nav-nodes").click();
		await expect(mp.getByRole("row").filter({ hasText: "operate" })).toBeVisible({ timeout: 15_000 });
	} finally {
		await ctx.close();
	}
});

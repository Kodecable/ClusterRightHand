import type { Page } from "@playwright/test";
import { expect, login, test } from "./fixtures.ts";

test.use({ withNode: true });

const MEMBER = { username: "mallory", password: "member-password-1" };

async function addedMemberShowsUp(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: `Remove ${MEMBER.username}` })).toBeVisible();
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
	await page.goto("/#/users");
	await page.getByLabel("Username").fill(MEMBER.username);
	await page.getByLabel("Display name").fill("Mallory M");
	await page.getByLabel("Password").fill(MEMBER.password);
	await page.getByRole("button", { name: "Create user" }).click();
	const userRow = page.getByRole("row").filter({ hasText: MEMBER.username });
	await expect(userRow).toBeVisible();
	await expect(userRow.getByLabel(`Kind of ${MEMBER.username}`)).toHaveValue("member");

	await page.getByLabel("Group name").fill("ops");
	await page.getByRole("button", { name: "Create group" }).click();
	await expect(page.getByRole("heading", { name: "ops" })).toBeVisible();
	await page.getByLabel("Add member to ops").selectOption({ label: MEMBER.username });
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await addedMemberShowsUp(page);

	// Member in a separate browser context: sees no node.
	const ctx = await browser.newContext({ baseURL: crhs.url });
	try {
		const mp = await ctx.newPage();
		await login(mp, MEMBER);
		await expect(mp.getByText("Mallory M")).toBeVisible();
		await expect(mp.getByText("No nodes yet.")).toBeVisible();
		await expect(mp.getByRole("link", { name: "Users" })).toHaveCount(0);

		// Admin shares the node (view).
		await page.goto(`/#/nodes/${nodeId}`);
		const shares = page.getByRole("region", { name: "Shares" });
		await shares.getByLabel("Grantee").selectOption({ label: "Mallory M" });
		await shares.getByLabel("Access").selectOption("view");
		await shares.getByRole("button", { name: "Add share" }).click();
		await expect(shares.getByRole("row").filter({ hasText: "view" })).toBeVisible();

		// Member sees the node but gets no run panel.
		await mp.getByRole("button", { name: "Refresh" }).click();
		await expect(mp.getByRole("link", { name: nodeName })).toBeVisible();
		await mp.getByRole("link", { name: nodeName }).click();
		await expect(mp.getByRole("heading", { name: nodeName })).toBeVisible();
		await expect(mp.getByRole("heading", { name: "Run" })).toHaveCount(0);
		await expect(mp.getByRole("button", { name: "Run", exact: true })).toHaveCount(0);
		await expect(mp.getByRole("region", { name: "Shares" })).toHaveCount(0);
		// The API refuses too.
		const denied = await mp.request.post(`/api/nodes/${nodeId}/tasks`, { data: { kind: "exec", shell: "true" } });
		expect(denied.status()).toBe(403);
		expect((await denied.json()).error).toBe("view access only");

		// Admin upgrades the share to operate.
		await shares.getByLabel("Grantee").selectOption({ label: "Mallory M" });
		await shares.getByLabel("Access").selectOption("operate");
		await shares.getByRole("button", { name: "Add share" }).click();
		await expect(shares.getByRole("row").filter({ hasText: "operate" })).toBeVisible();

		// Member can now run a task.
		await mp.reload();
		await expect(mp.getByRole("heading", { name: "Run" })).toBeVisible();
		await mp.getByRole("textbox", { name: "Shell command" }).fill("echo member-ran");
		await mp.getByRole("button", { name: "Run", exact: true }).click();
		await expect(mp.locator(".task-result").getByRole("region", { name: /stdout/ })).toContainText("member-ran");
	} finally {
		await ctx.close();
	}
});

test("a share to a user group gives its members access", async ({ adminPage: page, browser, crhs, env }) => {
	const nodeId = env?.nodeId as string;
	await crhs.api("/api/users", { body: { username: MEMBER.username, kind: "member", password: MEMBER.password } });
	await page.goto("/#/users");
	await page.getByLabel("Group name").fill("ops");
	await page.getByRole("button", { name: "Create group" }).click();
	await page.getByLabel("Add member to ops").selectOption({ label: MEMBER.username });
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await addedMemberShowsUp(page);

	await page.goto(`/#/nodes/${nodeId}`);
	const shares = page.getByRole("region", { name: "Shares" });
	await shares.getByLabel("Type").selectOption("user_group");
	await shares.getByLabel("Grantee").selectOption({ label: "ops" });
	await shares.getByLabel("Access").selectOption("operate");
	await shares.getByRole("button", { name: "Add share" }).click();
	await expect(shares.getByRole("row").filter({ hasText: "ops" })).toBeVisible();

	const ctx = await browser.newContext({ baseURL: crhs.url });
	try {
		const mp = await ctx.newPage();
		await login(mp, MEMBER);
		await expect(mp.getByRole("row").filter({ hasText: "operate" })).toBeVisible();
	} finally {
		await ctx.close();
	}
});

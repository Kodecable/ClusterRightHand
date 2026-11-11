import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

test("an administrator deletes a node from its page and returns to the node list", async ({ adminPage: page, env }) => {
	if (!env) throw new Error("withNode");
	await page.goto("/nodes");
	const nodeLink = page.getByRole("link", { name: "e2e", exact: true });
	await expect(nodeLink).toBeVisible();
	await nodeLink.click();
	await expect(page).toHaveURL(new RegExp(`/nodes/${env.nodeId}$`));

	await page.getByRole("button", { name: "Delete node" }).click();
	const dialog = page.getByRole("dialog", { name: "Delete node e2e?" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Delete node", exact: true }).click();

	await expect(page).toHaveURL(/\/nodes$/);
	await expect(page.getByRole("link", { name: "e2e", exact: true })).toHaveCount(0);
	await expect.poll(async () => (await env.crhs.api(`/api/nodes/${env.nodeId}`)).status).toBe(404);
});

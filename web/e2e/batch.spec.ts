import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

/** Picks one node by name in the batch page's node popover. */
async function pickNode(page: import("@playwright/test").Page, name: string): Promise<void> {
	await page.getByRole("button", { name: /Choose nodes|node selected/ }).click();
	await page.getByRole("checkbox", { name }).check();
	await page.keyboard.press("Escape");
}

test("runs a batch on a node picked by name", async ({ adminPage: page, crhs }) => {
	await page.goto("/batch");
	const { json } = await crhs.api("/api/nodes");
	const name: string = json.nodes[0].name;
	await pickNode(page, name);
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo batch-by-name");
	await page.getByLabel("Output").click();
	await page.getByRole("option", { name: "Tail of output" }).click();
	await page.getByRole("button", { name: /Run on 1 target/ }).click();
	const row = page.getByTestId("task-group-member").filter({ hasText: name });
	await expect(row).toContainText("Finished", { timeout: 20_000 });
	await row.getByText("Show").click();
	await expect(row.getByRole("region", { name: "output" })).toContainText("batch-by-name");
});

test("batch status shows the node's output file instead of output", async ({ adminPage: page, crhs }) => {
	await page.goto("/batch");
	const { json } = await crhs.api("/api/nodes");
	const name: string = json.nodes[0].name;
	await pickNode(page, name);
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo status-only");
	// Status is the default; crhs keeps no output, only the node's file.
	await page.getByRole("button", { name: /Run on 1 target/ }).click();
	const row = page.getByTestId("task-group-member").filter({ hasText: name });
	await expect(row).toContainText("Finished", { timeout: 20_000 });
	await row.getByText("Show").click();
	await expect(row.getByText(/Status only/)).toBeVisible();
});

test("runs a batch on a node-group target", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	// Node groups are crhs-managed now (D109): create one and add the node to it.
	const created = await crhs.api("/api/node-groups", { body: { name: "web" } });
	expect(created.status).toBe(201);
	const groupId: string = created.json.group.id;
	const members = await crhs.api(`/api/node-groups/${groupId}/members`, {
		method: "PUT",
		body: { nodeIds: [env.nodeId] },
	});
	expect(members.status).toBe(200);
	await page.goto("/batch");
	await page.getByRole("button", { name: /Choose node groups/ }).click();
	await page.getByRole("checkbox", { name: /web/ }).check();
	await page.keyboard.press("Escape");
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo from-group; exit 2");
	await page.getByRole("button", { name: /Run on 1 target/ }).click();
	await expect(page.getByTestId("task-group-member")).toContainText("Exit code 2", { timeout: 20_000 });
});

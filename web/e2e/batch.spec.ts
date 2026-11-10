import type { Page } from "@playwright/test";
import type { Env, InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

/** Opens the tasks page's "Run task" dialog. */
async function openRunTask(page: Page): Promise<void> {
	await page.goto("/tasks");
	await page.getByTestId("run-task").click();
	await expect(page.getByRole("dialog", { name: "Run task" })).toBeVisible();
}

/** Picks a target by name in the dialog's merged node / node-group picker. */
async function pickTarget(page: Page, name: string | RegExp): Promise<void> {
	await page.getByRole("combobox", { name: "Nodes or node groups" }).click();
	// A node option reads "<name> <hostname> Node"; a node group with a similar name ends in "Node group".
	await page.getByRole("option", { name: typeof name === "string" ? new RegExp(`^${name} .*Node$`) : name }).click();
	await page.keyboard.press("Escape");
}

/** Creates the "web" node group with the enrolled node as its only member (D109). */
async function createWebGroup(crhs: InProcessCrhs, env: Env): Promise<void> {
	const created = await crhs.api("/api/node-groups", { body: { name: "web" } });
	expect(created.status).toBe(201);
	const members = await crhs.api(`/api/node-groups/${created.json.group.id}/members`, {
		method: "PUT",
		body: { nodeIds: [env.nodeId] },
	});
	expect(members.status).toBe(200);
}

test("runs a task on a node picked by name", async ({ adminPage: page, crhs }) => {
	const { json } = await crhs.api("/api/nodes");
	const name: string = json.nodes[0].name;
	await openRunTask(page);
	await pickTarget(page, name);
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo batch-by-name");
	await page.getByRole("button", { name: "Run", exact: true }).click();

	// One node is one task: the task page shows the kept output.
	await expect(page.getByTestId("task-page")).toBeVisible();
	await expect(page.getByRole("region", { name: "output" })).toContainText("batch-by-name");
});

test("batch status shows the node's output file instead of output", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	const { json } = await crhs.api("/api/nodes");
	const name: string = json.nodes[0].name;
	await createWebGroup(crhs, env);
	await openRunTask(page);
	await pickTarget(page, /web/);
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo status-only");
	// Status is the default; crhs keeps no output, only the node's file.
	await page.getByRole("button", { name: "Run", exact: true }).click();

	await expect(page.getByTestId("task-group-page")).toBeVisible();
	const row = page.getByTestId("task-group-member").filter({ hasText: name });
	await expect(row).toContainText("Finished", { timeout: 20_000 });
	await row.getByRole("link", { name }).click();
	await expect(page.getByText(/Status only/)).toBeVisible();
});

test("runs a batch on a node-group target", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	await createWebGroup(crhs, env);
	await openRunTask(page);
	await pickTarget(page, /web/);
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo from-group; exit 2");
	await page.getByRole("button", { name: "Run", exact: true }).click();

	await expect(page.getByTestId("task-group-page")).toBeVisible();
	await expect(page.getByTestId("task-group-member")).toContainText("Exit code 2", { timeout: 20_000 });
});

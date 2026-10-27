import { appendFile } from "node:fs/promises";
import { runCrha } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

test("runs a batch on a node picked by name", async ({ adminPage: page, crhs }) => {
	await page.goto("/#/batch");
	const { json } = await crhs.api("/api/nodes");
	const name: string = json.nodes[0].name;
	await page.getByRole("checkbox", { name }).check();
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo batch-by-name");
	await page.getByRole("button", { name: "Run on 1 target(s)" }).click();
	const row = page.getByRole("row").filter({ has: page.getByRole("link", { name }) });
	await expect(row.getByText("exit 0")).toBeVisible({ timeout: 20_000 });
	await row.getByText("Show").click();
	await expect(row.getByRole("region", { name: /stdout/ })).toContainText("batch-by-name");
});

test("runs a batch on a group target", async ({ adminPage: page, crhs, env }) => {
	// A crha node's groups come from its own config.
	if (!env) throw new Error("withNode");
	await appendFile(env.configPath, 'groups = ["web"]\n');
	expect((await runCrha(env.bin, ["reload", "--config", env.configPath])).code).toBe(0);
	await expect
		.poll(async () => (await crhs.api(`/api/nodes/${env.nodeId}`)).json.node.groups, { timeout: 10_000 })
		.toEqual(["web"]);
	await page.goto("/#/batch");
	await page.getByLabel(/Groups or raw targets/).fill("group:web");
	await page.getByRole("textbox", { name: "Shell command" }).fill("echo from-group; exit 2");
	await page.getByRole("button", { name: "Run on 1 target(s)" }).click();
	await expect(page.getByRole("cell", { name: "exit 2" })).toBeVisible({ timeout: 20_000 });
});

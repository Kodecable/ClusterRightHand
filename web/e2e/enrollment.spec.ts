import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Env, runCrha } from "../../server/test/e2e/harness.ts";
import { test as base, expect } from "./fixtures.ts";
import { CRHA_BIN, WEB_DIST } from "./global-setup.ts";

// An environment with crhs and a config for crha, but no enrolled node: the test enrolls through the UI.
const test = base.extend<{ bare: Env }>({
	bare: async ({ browserName: _browser }, use) => {
		const dir = await mkdtemp(join(tmpdir(), "crh-ui-enroll-"));
		const env = await Env.create(CRHA_BIN, dir, {}, { webRoot: WEB_DIST });
		try {
			await use(env);
		} finally {
			await env.destroy();
			await rm(dir, { recursive: true, force: true });
		}
	},
	crhs: async ({ bare }, use) => use(bare.crhs),
});

test("enrolls a node with a token from the UI and approves it after checking the fingerprint", async ({
	adminPage: page,
	bare: env,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Add node" }).click();
	const dialog = page.getByRole("dialog", { name: "Add node" });
	await dialog.getByLabel("Name hint").fill("ui-enrolled");
	await dialog.getByRole("button", { name: "Create token" }).click();
	await expect(dialog.getByText("Run this on the node:")).toBeVisible();
	const command = ((await dialog.locator("pre").textContent()) ?? "").trim();
	const match = /^crha enroll (\S+) (\S+)$/.exec(command);
	expect(match, `unexpected command: ${command}`).not.toBeNull();
	const url = match?.[1] as string;
	const token = match?.[2] as string;
	expect(url).toBe(env.crhs.url);
	await dialog.getByRole("button", { name: "Close" }).click();

	await writeFile(env.configPath, `server = "${url}"\nstate_dir = "${join(env.dir, "crha")}"\n`);
	const enrolled = await runCrha(env.bin, ["enroll", "--config", env.configPath, url, token]);
	expect(enrolled.code, enrolled.stdout + enrolled.stderr).toBe(0);
	env.startCrha();

	await page.getByRole("button", { name: "Refresh" }).click();
	const row = page.getByRole("row").filter({ hasText: "pending" });
	await expect(row).toBeVisible({ timeout: 15_000 });
	await row.getByRole("button", { name: "Approve" }).click();

	const approve = page.getByRole("dialog", { name: "Approve node" });
	const { json } = await env.crhs.api("/api/nodes");
	const node = json.nodes.find((n: { status: string }) => n.status === "pending");
	expect(node.keyFingerprint).toMatch(/\S/);
	await expect(approve.locator("code").first()).toHaveText(node.keyFingerprint);
	await approve.getByRole("button", { name: "Approve", exact: true }).click();
	await expect(approve).toBeHidden();

	await expect(async () => {
		await page.getByRole("button", { name: "Refresh" }).click();
		await expect(page.getByRole("row").filter({ hasText: "active" })).toBeVisible({ timeout: 1000 });
	}).toPass({ timeout: 20_000 });
	await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
	await expect.poll(() => env.crhs.cluster.isConnected(node.id), { timeout: 20_000 }).toBe(true);
});

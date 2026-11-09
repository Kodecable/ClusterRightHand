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
	await page.goto("/nodes");
	await page.getByTestId("add-node").click();
	const dialog = page.getByTestId("add-node-dialog");
	await dialog.getByLabel("Node name").fill("ui-enrolled");
	await dialog.getByRole("button", { name: "New token" }).click();
	await expect(dialog.getByText("Run this on the node:")).toBeVisible();
	const command = ((await dialog.getByRole("region", { name: "Enrollment command" }).textContent()) ?? "").trim();
	const match = /^crha enroll --config (\S+) --state-dir (\S+) (\S+) (\S+)$/.exec(command);
	expect(match, `unexpected command: ${command}`).not.toBeNull();
	expect(match?.[1]).toBe("/etc/crha/crha.toml");
	expect(match?.[2]).toBe("/var/lib/crha");
	const url = match?.[3] as string;
	const token = match?.[4] as string;
	expect(url).toBe(env.crhs.url);
	await dialog.getByRole("button", { name: "Close" }).first().click();

	await writeFile(env.configPath, `server = "${url}"\nstate_dir = "${join(env.dir, "crha")}"\n`);
	const enrolled = await runCrha(env.bin, ["enroll", "--config", env.configPath, url, token]);
	expect(enrolled.code, enrolled.stdout + enrolled.stderr).toBe(0);
	env.startCrha();

	// The node list polls, so the pending enrolment appears without a refresh.
	const row = page.getByRole("row", { name: /ui-enrolled/ }).filter({ hasText: "Pending" });
	await expect(row).toBeVisible({ timeout: 15_000 });
	await row.getByRole("button", { name: "Approve" }).click();

	const approve = page.getByRole("dialog", { name: "Approve node" });
	const { json } = await env.crhs.api("/api/nodes");
	const node = json.nodes.find((candidate: { status: string }) => candidate.status === "pending");
	expect(node.keyFingerprint).toMatch(/\S/);
	await expect(approve.locator("code").first()).toHaveText(node.keyFingerprint);
	await approve.getByRole("button", { name: "Approve", exact: true }).click();
	await expect(approve).toBeHidden();

	await expect(page.getByRole("row", { name: /ui-enrolled/ })).not.toContainText("Pending", { timeout: 20_000 });
	await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
	await expect.poll(() => env.crhs.cluster.isConnected(node.id), { timeout: 20_000 }).toBe(true);
	await expect(page.getByRole("row", { name: /ui-enrolled/ }).getByText("Connected")).toBeVisible({
		timeout: 20_000,
	});

	// Once crha stops, the node shows offline.
	await env.killCrha();
	await expect.poll(() => env.crhs.cluster.isConnected(node.id), { timeout: 20_000 }).toBe(false);
	await expect(page.getByRole("row", { name: /ui-enrolled/ }).getByText("Offline")).toBeVisible({
		timeout: 20_000,
	});
});

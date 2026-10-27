import { create } from "@bufbuild/protobuf";
import { TaskSpecSchema } from "@crh/protocol";
import type { Page } from "@playwright/test";
import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

/** Creates an Ask token in the UI and returns the secret shown once, with the token's id. */
async function createToken(page: Page, crhs: InProcessCrhs, name: string) {
	await page.goto("/#/tokens");
	await page.getByRole("button", { name: "Create token" }).click();
	const dialog = page.getByRole("dialog", { name: "Create API token" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Create token" }).click();
	const done = page.getByRole("dialog", { name: "Token created" });
	const token = (await done.getByLabel("API token").textContent()) ?? "";
	expect(token).toMatch(/^crh_/);
	await expect(done).toContainText("will not be shown again");
	await expect(done.getByLabel("Claude Code command")).toContainText(`/mcp --header "Authorization: Bearer ${token}"`);
	await done.getByRole("button", { name: "Done" }).click();
	const list = await crhs.api("/api/api-tokens");
	const id: string = list.json.tokens.find((t: { name: string }) => t.name === name).id;
	return { token, id };
}

async function waitingTask(crhs: InProcessCrhs, nodeId: string, tokenId: string, word: string) {
	const me = await crhs.api("/api/me");
	const userId: string = me.json.user.id;
	return crhs.cluster.createTask({
		nodeId,
		spec: create(TaskSpecSchema, {
			kind: { case: "exec", value: { argv: ["echo", word], shell: "", env: {}, cwd: "" } },
		}),
		actor: { type: "api_token", id: tokenId, onBehalfOfUserId: userId },
		chain: [{ type: "api_token", id: tokenId }],
	});
}

test("approve and always allow adds a rule to the token and runs the task", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	const { id } = await createToken(page, crhs, "claude-laptop");
	const task = await waitingTask(crhs, env.nodeId, id, "hi");
	expect(task.state).toBe("awaiting_approval");

	await page.goto("/#/approvals");
	await expect(page.getByRole("link", { name: /Approvals/ })).toContainText("1");
	const card = page.getByRole("region", { name: `Task ${task.id}` });
	await expect(card).toContainText("API token claude-laptop");
	await expect(card).toContainText("echo hi");
	await expect(card.getByRole("table", { name: "Rule chain evaluation" })).toContainText("require-approval");
	await card.getByRole("button", { name: "Approve and always allow…" }).click();
	const rule = card.getByLabel("Rule to add to the token");
	await expect(rule).toHaveValue(/"exact": "echo hi"/);
	await card.getByLabel("prefix").check();
	await expect(rule).toHaveValue(/"prefix": "echo hi"/);
	await card.getByRole("button", { name: "Approve and always allow", exact: true }).click();
	await expect(page.getByText("Nothing is waiting for your approval.")).toBeVisible();

	await page.goto(`/#/tasks/${task.id}`);
	await expect(page.getByText("exited")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("region", { name: /stdout/ })).toContainText("hi");

	const tokens = await crhs.api("/api/api-tokens");
	const view = tokens.json.tokens.find((t: { id: string }) => t.id === id);
	expect(view.rules.rules).toContainEqual(
		expect.objectContaining({ action: "allow", method: "exec", prefix: "echo hi" }),
	);

	// The rule is shown on the tokens page too.
	await page.goto("/#/tokens");
	await page.getByRole("button", { name: "Rules", exact: true }).click();
	await page.getByRole("button", { name: /Added rules \(1\)/ }).click();
	await expect(page.getByLabel("Rules as JSON")).toHaveValue(/"prefix": "echo hi"/);
});

test("reject shows the reason on the task and the audit page lists the approval", async ({
	adminPage: page,
	crhs,
	env,
}) => {
	if (!env) throw new Error("withNode");
	const { id } = await createToken(page, crhs, "rejected-one");
	const task = await waitingTask(crhs, env.nodeId, id, "nope");

	await page.goto(`/#/approvals/tasks/${task.id}`);
	const card = page.getByRole("region", { name: `Task ${task.id}` });
	await card.getByLabel(/Reason/).fill("too risky");
	await card.getByRole("button", { name: "Reject" }).click();
	await expect(page.getByRole("heading", { name: "Already settled" })).toBeVisible();
	await expect(page.getByText("too risky", { exact: true })).toBeVisible();

	await page.goto(`/#/tasks/${task.id}`);
	await expect(page.getByText("rejected").first()).toBeVisible();
	await expect(page.getByText("too risky", { exact: true })).toBeVisible();

	await page.goto("/#/audit");
	await page.getByLabel(/^Action/).fill("task.");
	await page.getByRole("button", { name: "Filter" }).click();
	const row = page.getByRole("row").filter({ hasText: "task.approval" });
	await expect(row.getByRole("link", { name: task.id })).toHaveAttribute("href", `#/tasks/${task.id}`);
	await row.getByRole("button", { name: "Detail" }).click();
	await expect(page.getByLabel(/Detail of event/)).toContainText("rejected");
	await page.getByRole("button", { name: "Verify chain" }).click();
	await expect(page.getByText(/chain intact/)).toBeVisible();
});

test("revoking a token needs confirmation", async ({ adminPage: page, crhs }) => {
	await createToken(page, crhs, "to-revoke");
	await page.goto("/#/tokens");
	await page.getByRole("button", { name: "Revoke" }).click();
	await page
		.getByRole("dialog", { name: /Revoke token to-revoke/ })
		.getByRole("button", { name: "Revoke token" })
		.click();
	await expect(page.getByRole("cell", { name: "revoked" })).toBeVisible();
	await page.getByRole("button", { name: "Delete" }).click();
	await expect(page.getByText("No API tokens yet.")).toBeVisible();
});

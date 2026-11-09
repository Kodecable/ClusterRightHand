import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

/** The exec spec shape the harness's `cluster.createTask` accepts. */
type TaskSpec = Parameters<InProcessCrhs["cluster"]["createTask"]>[0]["spec"];

/** Creates an Ask token through the API and returns it. */
async function askToken(crhs: InProcessCrhs, name: string): Promise<{ id: string; name: string }> {
	const created = await crhs.api("/api/api-tokens", { body: { name, rulePreset: "ask", days: 30 } });
	expect(created.status).toBe(201);
	return { id: created.json.apiToken.id as string, name };
}

/** A task asked by an API token: under Ask it waits for the user's approval. */
async function waitingTask(crhs: InProcessCrhs, nodeId: string, tokenId: string, word: string) {
	const me = await crhs.api("/api/me");
	const userId: string = me.json.user.id;
	const spec: TaskSpec = {
		kind: "exec",
		command: { argv: ["echo", word] },
		env: {},
		cwd: "",
		stdin: null,
	};
	return crhs.cluster.createTask({
		nodeId,
		spec,
		actor: { type: "api_token", id: tokenId, onBehalfOfUserId: userId },
		chain: [{ type: "api_token", id: tokenId }],
	});
}

test("approve and always allow adds a rule to the token and runs the task", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	const token = await askToken(crhs, "claude-laptop");
	const task = await waitingTask(crhs, env.nodeId, token.id, "hi");
	expect(task.state).toBe("awaiting_approval");

	await page.goto("/approvals");
	await expect(page.getByTestId("nav-approvals-badge")).toContainText("1");
	const card = page.getByRole("region", { name: `Task ${task.id}` });
	await expect(card).toContainText("API token claude-laptop");
	await expect(card).toContainText("echo hi");
	await expect(card.getByRole("table", { name: "Rule chain evaluation" })).toContainText("Require approval");
	await card.getByRole("button", { name: /Approve and always allow/ }).click();
	const rule = card.getByLabel("Rule to add to the caller's rule set");
	await expect(rule).toHaveValue(/"exact": "echo hi"/);
	await card.getByLabel("prefix").check();
	await expect(rule).toHaveValue(/"prefix": "echo hi"/);
	await card.getByRole("button", { name: "Approve and always allow", exact: true }).click();
	await expect(page.getByText("Nothing is waiting for you")).toBeVisible();

	await page.goto(`/tasks/${task.id}`);
	await expect(page.getByText("Finished").first()).toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("region", { name: "output", exact: true })).toContainText("hi");

	const tokens = await crhs.api("/api/api-tokens");
	const view = tokens.json.tokens.find((candidate: { id: string }) => candidate.id === token.id);
	expect(view.rules.rules).toContainEqual(
		expect.objectContaining({ action: "allow", method: "exec", prefix: "echo hi" }),
	);

	// The rule is shown on the tokens page too.
	await page.goto("/tokens");
	await page.getByRole("row").filter({ hasText: "claude-laptop" }).getByRole("button", { name: "Rules" }).click();
	const dialog = page.getByTestId("token-rules-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("Added rules (JSON)")).toHaveValue(/"prefix": "echo hi"/);
});

test("reject shows the reason on the task and the audit page lists the approval", async ({
	adminPage: page,
	crhs,
	env,
}) => {
	if (!env) throw new Error("withNode");
	const token = await askToken(crhs, "rejected-one");
	const task = await waitingTask(crhs, env.nodeId, token.id, "nope");

	await page.goto(`/approvals/tasks/${task.id}`);
	const card = page.getByRole("region", { name: `Task ${task.id}` });
	await card.getByLabel(/Reason/).fill("too risky");
	await card.getByRole("button", { name: "Reject", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Already settled" })).toBeVisible();

	await page.goto(`/tasks/${task.id}`);
	await expect(page.getByText("Rejected").first()).toBeVisible();
	await expect(page.getByText("too risky", { exact: true }).first()).toBeVisible();

	await page.goto("/audit");
	await page.getByLabel("Action").fill("task.");
	await page.getByRole("button", { name: "Filter" }).click();
	const row = page.getByRole("row").filter({ hasText: "task.approval" }).first();
	await expect(row).toBeVisible({ timeout: 15_000 });
	await expect(row.getByRole("link", { name: `Open task ${task.id}` })).toHaveAttribute("href", `/tasks/${task.id}`);
	await row.getByRole("button", { name: /Detail of event/ }).click();
	const dialog = page.getByRole("dialog", { name: /Event \d+/ });
	await expect(dialog).toContainText("rejected");
});

test("revoking a token needs confirmation", async ({ adminPage: page }) => {
	await page.goto("/tokens");
	await page.getByTestId("create-token").click();
	const create = page.getByTestId("create-token-dialog");
	await create.getByLabel("Name").fill("to-revoke");
	await create.getByRole("button", { name: "Create token" }).click();
	const done = page.getByRole("dialog", { name: "Token created" });
	await expect(done).toContainText("crh_");
	await done.getByRole("button", { name: "Done" }).click();

	await page.getByRole("row").filter({ hasText: "to-revoke" }).getByRole("button", { name: "Revoke" }).click();
	await page
		.getByRole("dialog", { name: "Revoke token to-revoke?" })
		.getByRole("button", { name: "Revoke token" })
		.click();
	await expect(page.getByRole("cell", { name: "Revoked" })).toBeVisible();
	await page.getByRole("row").filter({ hasText: "to-revoke" }).getByRole("button", { name: "Delete" }).click();
	await page
		.getByRole("dialog", { name: "Delete token to-revoke?" })
		.getByRole("button", { name: "Delete token" })
		.click();
	await expect(page.getByText("No API tokens yet")).toBeVisible();
});

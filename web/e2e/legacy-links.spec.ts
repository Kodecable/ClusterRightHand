import type { TaskSpec } from "@crh/protocol";
import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withNode: true });

/** Creates an Ask token through the API; the task below is asked by it. */
async function askToken(crhs: InProcessCrhs, name: string): Promise<{ id: string; userId: string }> {
	const created = await crhs.api("/api/api-tokens", { body: { name, rulePreset: "ask", days: 30 } });
	if (created.status !== 201) throw new Error(`token: ${created.status}`);
	const me = await crhs.api("/api/me");
	return { id: created.json.apiToken.id, userId: me.json.user.id };
}

/** A task of an API token that asks its rules: it waits for the user's approval. */
async function waitingTask(crhs: InProcessCrhs, nodeId: string, token: { id: string; userId: string }, word: string) {
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
		actor: { type: "api_token", id: token.id, onBehalfOfUserId: token.userId },
		chain: [{ type: "api_token", id: token.id }],
	});
}

test("an old #/approvals/tasks/:id link becomes the path and opens the approval", async ({
	adminPage: page,
	crhs,
	env,
}) => {
	if (!env) throw new Error("withNode");
	const token = await askToken(crhs, "legacy-link");
	const task = await waitingTask(crhs, env.nodeId, token, "old-link");
	expect(task.state).toBe("awaiting_approval");

	await page.goto(`/#/approvals/tasks/${task.id}`);
	await expect(page).toHaveURL(new RegExp(`/approvals/tasks/${task.id}$`));
	await expect(page.getByTestId("page-title")).toHaveText("Approvals");
	await expect(page.getByRole("region", { name: `Task ${task.id}` })).toBeVisible();
});

test("an old #/tasks/:id link becomes the path", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	const done = await crhs.runTask(env.nodeId, { kind: "exec", argv: ["echo", "legacy-task"] });
	expect(done.state).toBe("exited");

	await page.goto(`/#/tasks/${done.id}`);
	await expect(page).toHaveURL(new RegExp(`/tasks/${done.id}$`));
	await expect(page.getByTestId("task-page")).toContainText("legacy-task");
	// Once the task has loaded, the shell is titled with its command (usePageTitle), not "Tasks".
	await expect(page.getByTestId("page-title")).toHaveText("echo legacy-task");
});

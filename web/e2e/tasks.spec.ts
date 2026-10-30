import { expect, test } from "./fixtures.ts";

/**
 * The task page in the top navigation and the signature section of the approvals page
 * (doc/privilege.md: the WebUI entry points of a task awaiting authorization).
 */

test.use({ withNode: true });

test("lists tasks across nodes, filters them and opens the task page", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	const done = await crhs.runTask(env.nodeId, { kind: "exec", argv: ["echo", "tasks-page-marker"] });
	expect(done.state).toBe("exited");

	await page.goto("/#/tasks");
	await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
	const row = page.getByRole("row").filter({ hasText: "tasks-page-marker" });
	await expect(row).toContainText("exited");

	// A state the task is not in hides it; clearing the filter brings it back.
	await page.getByLabel("State").selectOption("failed");
	await expect(page.getByRole("row").filter({ hasText: "tasks-page-marker" })).toHaveCount(0);
	await page.getByLabel("State").selectOption("");
	await row.getByRole("link", { name: "Details" }).click();
	await expect(page).toHaveURL(new RegExp(`#/tasks/${done.id}$`));
	await expect(page.getByRole("heading", { name: "Task" })).toBeVisible();
});

test("lists a task waiting for the user's signature on the approvals page", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	const t = await crhs.runTask(env.nodeId, { kind: "exec", argv: ["echo", "sign-me"] });
	// The page only reads the row; a real signature wait needs a forward node with trust.
	await crhs.db.updateTable("tasks").set({ state: "awaiting_authorization" }).where("id", "=", t.id).execute();

	await page.goto("/#/approvals");
	const section = page.getByRole("region", { name: "Waiting for your signature" });
	await expect(section).toContainText("sign-me");
	// The header counts approvals and signature waits together.
	await expect(page.getByRole("link", { name: /Approvals/ })).toContainText("1");
	await section.getByRole("link").first().click();
	await expect(page).toHaveURL(new RegExp(`#/tasks/${t.id}$`));
});

import { expect, test } from "./fixtures.ts";

/**
 * The task page in the navigation and the signature section of the approvals page
 * (doc/design/privilege.md: the WebUI entry points of a task awaiting authorization).
 */

test.use({ withNode: true });

test("lists tasks across nodes, filters them and opens the task page", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	const done = await crhs.runTask(env.nodeId, { kind: "exec", argv: ["echo", "tasks-page-marker"] });
	expect(done.state).toBe("exited");

	await page.goto("/tasks");
	await expect(page.getByTestId("page-title")).toHaveText("Tasks");
	await expect(page.getByTestId("nav-tasks")).toHaveAttribute("aria-current", "page");
	const row = page.getByRole("row").filter({ hasText: "tasks-page-marker" });
	await expect(row).toContainText("Finished");

	// A state the task is not in hides it; clearing the filter brings it back.
	await page.getByLabel("State").click();
	await page.getByRole("option", { name: "Failed", exact: true }).click();
	await expect(page.getByRole("row").filter({ hasText: "tasks-page-marker" })).toHaveCount(0);
	await page.getByLabel("State").click();
	await page.getByRole("option", { name: "Any state", exact: true }).click();
	await expect(row).toBeVisible();
	// The summary cell carries the row's real link (Created is the first column).
	await row.getByRole("link", { name: /tasks-page-marker/ }).click();
	await expect(page).toHaveURL(new RegExp(`/tasks/${done.id}$`));
	await expect(page.getByTestId("task-page")).toContainText("tasks-page-marker");
});

test("lists a task waiting for the user's signature on the approvals page", async ({ adminPage: page, crhs, env }) => {
	if (!env) throw new Error("withNode");
	const t = await crhs.runTask(env.nodeId, { kind: "exec", argv: ["echo", "sign-me"] });
	// The page only reads the row; a real signature wait needs a forward node with trust.
	await crhs.db.updateTable("tasks").set({ state: "awaiting_authorization" }).where("id", "=", t.id).execute();

	await page.goto("/approvals");
	const section = page.getByRole("region", { name: "Waiting for your signature" });
	await expect(section).toContainText("sign-me");
	// The header counts approvals and signature waits together.
	await expect(page.getByTestId("nav-approvals-badge")).toContainText("1");
	await section.getByRole("link").first().click();
	await expect(page).toHaveURL(new RegExp(`/tasks/${t.id}$`));
});

import type { Page } from "@playwright/test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "../../server/test/e2e/harness.ts";
import { expect, newSession, sendMessage, test } from "./fixtures.ts";

test.use({ withAgent: true });

async function toolCard(page: Page) {
	const card = page.getByTestId("tool-card").filter({ hasText: "exec" });
	await expect(card).toBeVisible({ timeout: 20_000 });
	return card;
}

test("create a session, send a message and see the streamed answer", async ({ adminPage: page, crhs }) => {
	await newSession(page, "First chat");
	crhs.faux.setResponses([fauxAssistantMessage([fauxText("Hello from the faux model.")])]);
	await sendMessage(page, "Say hello");
	const log = page.getByTestId("transcript-scroller");
	await expect(log).toContainText("Say hello");
	await expect(log).toContainText("Hello from the faux model.");
	await expect(page.getByTestId("composer-input")).toHaveValue("");

	// The list row names the session and the list links back to it.
	await page.goto("/sessions");
	const row = page.getByTestId("session-item").filter({ hasText: "First chat" });
	await expect(row).toBeVisible();
	await row.click();
	await expect(page.getByTestId("transcript-scroller")).toContainText("Hello from the faux model.");
});

test("title and rule preset can be changed", async ({ adminPage: page }) => {
	await newSession(page, "Rename me");
	const title = page.getByTestId("session-title");
	await title.fill("Renamed");
	await title.press("Enter");
	await expect(title).toHaveValue("Renamed");
	// The title is shown once: a root session has no breadcrumb that repeats it.
	await expect(page.getByTestId("session-breadcrumb")).toHaveCount(0);

	// The rule preset is in the composer footer now: click it, pick Yolo, and the footer says so.
	await page.getByTestId("composer-rules").click();
	await page.getByRole("option", { name: "Yolo", exact: true }).click();
	await expect(page.getByTestId("composer-rules")).toContainText("Yolo");
	await page.keyboard.press("Escape");
	await page.reload();
	await expect(page.getByTestId("page-title")).toHaveText("Sessions");
	await expect(page.getByTestId("composer-rules")).toContainText("Yolo");
});

test.describe("with a node", () => {
	test.use({ withNode: true });

	test("a tool call shows a card with the result (yolo)", async ({ adminPage: page, crhs, env }) => {
		if (!env) throw new Error("withNode");
		await newSession(page, "Tools", "Yolo");
		crhs.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { targets: [env.nodeId], cmd: "echo from-agent" }, { id: "call-1" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxText("The command printed from-agent.")]),
		]);
		await sendMessage(page, "run echo");
		const card = await toolCard(page);
		await expect(card).toContainText("echo from-agent");
		// The card opens a dialog with the call's result and the task it ran.
		await card.getByTestId("tool-toggle").click();
		const dialog = page.getByTestId("tool-dialog");
		await expect(dialog).toContainText("Result");
		await expect(dialog).toContainText("Finished");
		await expect(dialog.getByRole("region", { name: "output", exact: true })).toContainText("from-agent");
		await expect(page.getByTestId("transcript-scroller")).toContainText("The command printed from-agent.");
	});

	test("under ask the card waits for approval and the answer arrives after approving", async ({
		adminPage: page,
		crhs,
		env,
	}) => {
		if (!env) throw new Error("withNode");
		await newSession(page, "Ask chat");
		crhs.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { targets: [env.nodeId], cmd: "echo approve-me" }, { id: "call-1" })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxText("Approved and done.")]),
		]);
		await sendMessage(page, "run it");
		const sessionUrl = page.url();
		await expect(page.getByTestId("waiting-reason")).toContainText("waiting for an approval");
		const card = await toolCard(page);
		await card.getByTestId("tool-toggle").click();
		await page.getByTestId("tool-dialog").getByRole("link", { name: "Review and approve" }).click();
		await expect(page).toHaveURL(/\/approvals\/tasks\//);
		await page.getByRole("button", { name: "Approve", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Already settled" })).toBeVisible();

		await page.goto(sessionUrl);
		await expect(page.getByTestId("transcript-scroller")).toContainText("Approved and done.", { timeout: 20_000 });
		await expect(page.getByTestId("tool-card").filter({ hasText: "exec" })).toHaveAttribute(
			"data-tool-status",
			"done",
			{
				timeout: 20_000,
			},
		);
	});

	test("Stop ends a run that waits for approval", async ({ adminPage: page, crhs, env }) => {
		if (!env) throw new Error("withNode");
		await newSession(page, "Stop chat");
		crhs.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("exec", { targets: [env.nodeId], cmd: "echo never" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("unused")]),
		]);
		await sendMessage(page, "run it");
		await expect(page.getByTestId("waiting-reason")).toContainText("waiting for an approval");
		await page.getByTestId("abort-session").click();
		await expect(page.getByTestId("waiting-reason")).toHaveCount(0, { timeout: 20_000 });
		await expect(page.getByTestId("composer-input")).toBeEnabled();
	});
});

test("admin model settings: add a custom provider and see its model in the new-session draft", async ({
	adminPage: page,
}) => {
	await page.goto("/settings/models");
	await expect(page.getByTestId("page-title")).toHaveText("Models");
	await page.getByTestId("add-provider").click();
	const dialog = page.getByRole("dialog", { name: "New provider" });
	await dialog.getByLabel("Kind").click();
	await page.getByRole("option", { name: "Custom" }).click();
	await dialog.getByLabel("Provider id").fill("local-llm");
	await dialog.getByLabel("Name").fill("Local LLM");
	await dialog.getByLabel("Base URL").fill("http://127.0.0.1:9/v1");
	await dialog.getByLabel("API key").fill("sk-secret");
	await dialog.getByRole("button", { name: "New model" }).click();
	const model = page.getByTestId("model-dialog");
	await model.getByLabel("Model id").fill("tiny-1");
	await model.getByRole("button", { name: "Save model" }).click();
	await expect(page.getByTestId("model-dialog")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Save provider" }).click();
	const row = page.getByRole("row").filter({ hasText: "local-llm" });
	await expect(row).toContainText("tiny-1");
	await expect(row).toContainText("Set");

	await page.goto("/sessions");
	await page.getByTestId("new-session-button").click();
	await expect(page).toHaveURL(/\/sessions\/new$/);
	await page.getByTestId("composer-model").click();
	await expect(page.getByRole("option", { name: "tiny-1" })).toBeAttached();
	await page.keyboard.press("Escape");

	await page.goto("/settings/models");
	await page.getByRole("button", { name: "Delete local-llm" }).click();
	await page
		.getByRole("dialog", { name: /Delete provider/ })
		.getByRole("button", { name: "Delete provider" })
		.click();
	await expect(page.getByRole("row").filter({ hasText: "local-llm" })).toHaveCount(0);
});

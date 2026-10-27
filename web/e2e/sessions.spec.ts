import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Page } from "@playwright/test";
import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { expect, test } from "./fixtures.ts";

test.use({ withAgent: true });

const modelLabel = (crhs: InProcessCrhs) => crhs.faux.getModel().name;

async function newSession(page: Page, crhs: InProcessCrhs, title: string, preset = "Ask") {
	await page.goto("/#/sessions");
	await page.getByRole("button", { name: "New session" }).click();
	const dialog = page.getByRole("dialog", { name: "New session" });
	await dialog.getByLabel("Title").fill(title);
	await dialog.getByLabel("Model").selectOption({ label: modelLabel(crhs) });
	await dialog.getByLabel("Preset").selectOption({ label: preset });
	await dialog.getByRole("button", { name: "Create session" }).click();
	await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

async function send(page: Page, text: string) {
	await page.getByLabel("Message").fill(text);
	await page.getByLabel("Message").press("Enter");
}

test("create a session, send a message and see the streamed answer", async ({ adminPage: page, crhs }) => {
	crhs.faux.setResponses([fauxAssistantMessage([fauxText("Hello from the faux model.")])]);
	await newSession(page, crhs, "First chat");
	await expect(page.getByRole("log", { name: "Conversation" })).toContainText("No messages yet");
	await send(page, "Say hello");
	const log = page.getByRole("log", { name: "Conversation" });
	await expect(log).toContainText("Say hello");
	await expect(log).toContainText("Hello from the faux model.");
	await expect(page.getByLabel("Message")).toHaveValue("");

	await page.goto("/#/sessions");
	const row = page.getByRole("row", { name: /First chat/ });
	await expect(row).toContainText("ask");
	await row.getByRole("link", { name: "First chat" }).click();
	await expect(page.getByRole("log", { name: "Conversation" })).toContainText("Hello from the faux model.");
});

test("a tool call paused for quota is granted from the approvals page", async ({ adminPage: page, crhs }) => {
	const created = await crhs.api("/api/sessions", {
		body: {
			title: "Quota",
			preset: "yolo",
			quota: 100,
			model: { provider: crhs.faux.provider.id, modelId: crhs.faux.getModel().id },
		},
	});
	expect(created.status).toBe(201);
	const id = created.json.session.id as string;
	crhs.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("list_nodes", {}, { id: "qa" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("resumed after the grant")]),
	]);
	await page.goto(`/#/sessions/${id}`);
	await page.getByLabel("Message").fill("list the nodes");
	await page.getByLabel("Message").press("Enter");

	await page.getByRole("link", { name: "Approvals" }).click();
	const card = page.getByRole("region", { name: /Quota request/ });
	await expect(card).toBeVisible();
	await expect(card).toContainText("tokens left");
	await card.getByLabel("Tokens to add").fill("10000");
	await card.getByRole("button", { name: "Grant" }).click();
	await expect(card).toHaveCount(0);

	await page.goto(`/#/sessions/${id}`);
	await expect(page.getByRole("log", { name: "Conversation" })).toContainText("resumed after the grant");
});

test("title and preset can be changed", async ({ adminPage: page, crhs }) => {
	await newSession(page, crhs, "Rename me");
	await page.getByLabel("Title", { exact: true }).fill("Renamed");
	await page.getByRole("button", { name: "Save title" }).click();
	await expect(page.getByRole("heading", { name: "Renamed" })).toBeVisible();
	await page.getByLabel("Preset").selectOption({ label: "Yolo" });
	await page.reload();
	await expect(page.getByLabel("Preset")).toHaveValue("yolo");
	await expect(page.getByLabel("Preset").locator("option", { hasText: "Auto Review" })).toHaveAttribute("disabled", "");
});

test.describe("with a node", () => {
	test.use({ withNode: true });

	test("a tool call shows a card with the result (yolo)", async ({ adminPage: page, crhs, env }) => {
		if (!env) throw new Error("withNode");
		crhs.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("exec", { node: env.nodeId, cmd: "echo from-agent" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("The command printed from-agent.")]),
		]);
		await newSession(page, crhs, "Tools", "Yolo");
		await send(page, "run echo");
		const card = page.getByRole("region", { name: "Tool call exec" });
		await expect(card).toContainText("echo from-agent");
		await expect(card).toContainText("exited");
		await expect(card).toContainText("exit_code");
		await expect(page.getByRole("log")).toContainText("The command printed from-agent.");
	});

	test("under ask the card waits for approval and the answer arrives after approving", async ({
		adminPage: page,
		crhs,
		env,
	}) => {
		if (!env) throw new Error("withNode");
		crhs.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("exec", { node: env.nodeId, cmd: "echo approve-me" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Approved and done.")]),
		]);
		await newSession(page, crhs, "Ask chat");
		await send(page, "run it");
		const sessionUrl = page.url();
		const card = page.getByRole("region", { name: "Tool call exec" });
		await expect(card).toContainText("Waiting for your approval");
		await card.getByRole("link", { name: "Review and approve" }).click();
		await expect(page).toHaveURL(/#\/approvals\/tasks\//);
		await page.getByRole("button", { name: "Approve", exact: true }).click();
		await page.goto(sessionUrl);
		await expect(page.getByRole("log")).toContainText("Approved and done.");
		await expect(page.getByRole("region", { name: "Tool call exec" })).toContainText("exited");
	});

	test("Stop ends a run that waits for approval", async ({ adminPage: page, crhs, env }) => {
		if (!env) throw new Error("withNode");
		crhs.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("exec", { node: env.nodeId, cmd: "echo never" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("unused")]),
		]);
		await newSession(page, crhs, "Stop chat");
		await send(page, "run it");
		await expect(page.getByRole("region", { name: "Tool call exec" })).toContainText("Waiting for your approval");
		await page.getByRole("button", { name: "Stop" }).click();
		await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
		await expect(page.getByLabel("Message")).toBeEnabled();
	});
});

test("admin model settings: add an OpenAI-compatible provider and see its model in the new-session dialog", async ({
	adminPage: page,
}) => {
	await page.goto("/#/sessions");
	await page.getByRole("link", { name: "Models" }).click();
	await expect(page.getByRole("heading", { name: "Model providers" })).toBeVisible();
	await page.getByRole("button", { name: "Add provider" }).click();
	const dialog = page.getByRole("dialog", { name: "Add model provider" });
	await dialog.getByLabel("Kind").selectOption("openai-compatible");
	await dialog.getByLabel("Provider id").fill("local-llm");
	await dialog.getByLabel("Name").fill("Local LLM");
	await dialog.getByLabel("Base URL").fill("http://127.0.0.1:9/v1");
	await dialog.getByLabel("Model 1 id").fill("tiny-1");
	await dialog.getByLabel("API key").fill("sk-secret");
	await dialog.getByRole("button", { name: "Save provider" }).click();
	const row = page.getByRole("row", { name: /local-llm/ });
	await expect(row).toContainText("tiny-1");
	await expect(row).toContainText("set");

	await page.goto("/#/sessions");
	await page.getByRole("button", { name: "New session" }).click();
	await expect(
		page.getByRole("dialog", { name: "New session" }).getByRole("option", { name: "tiny-1" }),
	).toBeAttached();
	await page.getByRole("dialog", { name: "New session" }).getByRole("button", { name: "Cancel" }).click();

	await page.goto("/#/settings/models");
	await page.getByRole("button", { name: "Delete local-llm" }).click();
	await page
		.getByRole("dialog", { name: /Delete provider/ })
		.getByRole("button", { name: "Delete provider" })
		.click();
	await expect(page.getByRole("row", { name: /local-llm/ })).toHaveCount(0);
});

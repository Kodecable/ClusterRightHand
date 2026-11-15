import { expect, test } from "@playwright/test";
import { login, mockApi } from "./helpers";

test("create a Telegram channel", async ({ page }) => {
	const api = await mockApi(page);
	await login(page);
	await page.goto("/settings/channels");
	await expect(page.getByTestId("channels-page")).toBeVisible();
	await expect(page.getByTestId("channels-page")).toContainText("No channels yet");

	await page.getByTestId("add-channel").click();
	const dialog = page.getByTestId("channel-dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("Name").fill("opsbot");
	await dialog.getByLabel("Bot token").fill("123456:secret");
	await dialog.getByRole("button", { name: "Create channel" }).click();

	const table = page.getByRole("table", { name: "Channels" });
	await expect(table).toContainText("opsbot");
	await expect.poll(() => api.state.requests.some((request) => request.url === "/api/channels/opsbot")).toBe(true);
	const saved = api.state.requests.find(
		(request) => request.method === "PUT" && request.url === "/api/channels/opsbot",
	);
	expect(saved?.body).toMatchObject({ kind: "telegram", enabled: true, token: "123456:secret" });
});

test("create a link code for the user's chat account", async ({ page }) => {
	const api = await mockApi(page, {
		state: {
			channelAccounts: {
				accounts: [],
				channels: [{ id: "channel-1", name: "opsbot", kind: "telegram", account: "ops_bot", linkInstructions: null }],
			},
		},
	});
	await login(page);
	await page.getByTestId("user-menu-trigger").click();
	await page.getByTestId("menu-settings").click();
	await expect(page.getByTestId("user-settings-dialog")).toBeVisible();
	await page.getByTestId("settings-tab-chat").click();
	await expect(page.getByTestId("chat-accounts")).toBeVisible();
	await page.getByTestId("create-link-code").click();
	const dialog = page.getByTestId("link-code-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId("link-code")).toHaveText("/link ABCD2345");
	await expect(dialog).toContainText("@ops_bot");
	expect(api.state.requests.some((request) => request.url === "/api/channel-link-codes")).toBe(true);
});

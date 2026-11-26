import type { AvailableModel, SessionExtension } from "@crh/api";
import { expect, test } from "@playwright/test";
import { login, mockApi, snapshotEvent } from "./helpers";

const MODELS: AvailableModel[] = [
	{
		provider: "faux",
		providerName: "Faux",
		modelId: "faux-1",
		name: "Faux One",
		contextWindow: 128_000,
		thinkingLevels: ["off"],
		input: ["text"],
	},
];

const EXTENSIONS: SessionExtension[] = [
	{
		name: "alpha",
		kind: "mcp",
		description: "Alpha tools",
		enabled: true,
		available: true,
		listDirectly: false,
	},
	{
		name: "beta",
		kind: "builtin",
		description: null,
		enabled: true,
		available: true,
		listDirectly: true,
	},
];

test("the draft turns an extension off before the first message and the session starts with it off", async ({
	page,
}) => {
	const api = await mockApi(page, { state: { models: MODELS, availableExtensions: EXTENSIONS } });
	await login(page);
	await page.getByTestId("new-session-button").click();
	await expect(page).toHaveURL(/\/sessions\/new$/);
	await expect(page.getByTestId("new-session-input")).toBeVisible();

	const button = page.getByTestId("new-session-extensions");
	await expect(button).toHaveAttribute("aria-label", "Extensions: 2/2");
	await button.click();
	const dialog = page.getByTestId("extensions-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Alpha tools");
	await dialog.getByRole("checkbox").first().click();
	await expect(button).toHaveAttribute("aria-label", "Extensions: 1/2");

	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await page.getByTestId("new-session-input").fill("hello");
	await page.getByTestId("composer-send").click();
	await expect(page).toHaveURL(/\/sessions\/new-session-1$/);

	// The draft's local off list travels with the create request, not as a separate PATCH.
	const create = api.state.requests.find((request) => request.method === "POST" && request.url === "/api/sessions");
	expect(create?.body).toMatchObject({ message: "hello", disabledExtensions: ["alpha"] });
	await api.waitForStream("/api/sessions/new-session-1/events");
	await api.emit("/api/sessions/new-session-1/events", "events", snapshotEvent([], null));

	await expect(page.getByTestId("session-header")).toBeVisible();
	await expect(page.getByTestId("session-extensions")).toHaveAttribute("aria-label", "Extensions: 1/2");
});

test("on a narrow screen the draft's extensions button stays clear of the back button", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page, { state: { models: MODELS, availableExtensions: EXTENSIONS } });
	await login(page);
	await page.goto("/sessions/new");
	const extensions = await page.getByTestId("new-session-extensions").boundingBox();
	const back = await page.getByTestId("session-back").boundingBox();
	expect(extensions).not.toBeNull();
	expect(back).not.toBeNull();
	// The two controls are on opposite sides of the top row and do not overlap.
	expect((extensions?.x ?? 0) > (back?.x ?? 0) + (back?.width ?? 0)).toBe(true);
});

test("on a wide screen the draft's composer keeps to the session column, centred in the pane", async ({ page }) => {
	await page.setViewportSize({ width: 1800, height: 900 });
	await mockApi(page, { state: { models: MODELS, availableExtensions: EXTENSIONS } });
	await login(page);
	await page.goto("/sessions/new");
	await expect(page.getByTestId("new-session-input")).toBeVisible();
	const geometry = await page.evaluate(() => {
		const pane = document.querySelector<HTMLElement>('[data-testid="new-session-page"]');
		const input = document.querySelector<HTMLElement>('[data-testid="new-session-input"]');
		if (!pane || !input) return null;
		const rootFont = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
		const p = pane.getBoundingClientRect();
		const i = input.getBoundingClientRect();
		return { column: 52 * rootFont, width: i.width, left: i.left - p.left, right: p.right - i.right };
	});
	expect(geometry).not.toBeNull();
	expect(geometry?.width ?? Infinity).toBeLessThanOrEqual(geometry?.column ?? 0);
	expect(Math.abs((geometry?.left ?? 0) - (geometry?.right ?? 1000))).toBeLessThanOrEqual(2);
});

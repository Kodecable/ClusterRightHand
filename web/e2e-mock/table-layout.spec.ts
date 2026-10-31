import { expect, type Page, test } from "@playwright/test";
import {
	apiTokenView,
	auditEvent,
	login,
	mockApi,
	nodeView,
	providerView,
	sessionListItem,
	taskView,
	USER,
} from "./helpers";

/** Data every table page needs; each table is rendered with two rows so a body row always exists. */
const state = {
	sessions: [sessionListItem()],
	tasks: [taskView(), taskView({ id: "task-2", summary: "uptime" } as never)],
	nodes: [nodeView(), nodeView({ id: "node-2", name: "web-1" } as never)],
	audit: [auditEvent(), auditEvent({ id: "evt-2", seq: 2 } as never)],
	tokens: [apiTokenView()],
	providers: [providerView()],
	users: [USER],
	directory: { users: [USER], userGroups: [] },
};

const TABLE_PAGES = [
	["tasks", "/tasks"],
	["nodes", "/nodes"],
	["audit", "/audit"],
	["users", "/users"],
	["models", "/settings/models"],
	["tokens", "/tokens"],
] as const;

/** Every header cell starts at the same x as the body cell below it (the shared grid template). */
async function expectColumnsAligned(page: Page) {
	const table = page.locator('[data-slot="data-table"]').first();
	await expect(table).toBeVisible();
	const headers = table.locator('[role="columnheader"]');
	const row = table.locator('[role="row"]').nth(1);
	await expect(row).toBeVisible();
	const cells = row.locator('[role="cell"]');
	const count = await headers.count();
	expect(count).toBeGreaterThan(0);
	expect(await cells.count()).toBe(count);
	for (let index = 0; index < count; index += 1) {
		const header = await headers.nth(index).boundingBox();
		const cell = await cells.nth(index).boundingBox();
		expect(header, `header ${index}`).not.toBeNull();
		expect(cell, `cell ${index}`).not.toBeNull();
		expect(Math.abs((header?.x ?? 0) - (cell?.x ?? 0)), `column ${index}`).toBeLessThanOrEqual(1);
	}
}

for (const [name, path] of TABLE_PAGES) {
	test(`${name}: header cells sit above their values`, async ({ page }) => {
		await mockApi(page, { state });
		await login(page);
		await page.goto(path);
		await expectColumnsAligned(page);
	});
}

test("a narrow screen keeps the table's columns and scrolls sideways", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockApi(page, { state });
	await login(page);
	await page.goto("/tasks");

	// The header and its values still line up inside the scrolled table.
	await expectColumnsAligned(page);

	const scroll = page.locator('[data-slot="data-table-scroll"]').first();
	const metrics = await scroll.evaluate((element) => ({
		scrollWidth: element.scrollWidth,
		clientWidth: element.clientWidth,
	}));
	expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

	// Columns keep their minimum width instead of being crushed to "w…".
	const width = (await page.locator('[role="row"]').nth(1).locator('[role="cell"]').first().boundingBox())?.width ?? 0;
	expect(width).toBeGreaterThanOrEqual(100);
});

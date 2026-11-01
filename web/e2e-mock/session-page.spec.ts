import { expect, type Page, test } from "@playwright/test";
import { login, mockApi, openSession, sessionListItem, sessionView, snapshotEvent, userEntry } from "./helpers";

const MODELS = [{ provider: "faux", modelId: "faux-1", name: "Faux One", contextWindow: 128_000 }];

/** A session page whose footer has every counter, with the model list its context ring needs. */
async function openFooterPage(page: Page, overrides: Record<string, unknown> = {}) {
	const item = sessionListItem({ id: "s1", title: "Footer session", updatedAt: new Date().toISOString() });
	const api = await mockApi(page, {
		state: {
			sessions: [item],
			details: {
				s1: sessionView(item, {
					budgetRemaining: 12_345,
					budgetUsedTokens: 1_000,
					usageTokens: 1_500_000,
					contextTokens: 64_000,
					...overrides,
				} as never),
			},
			models: MODELS,
			events: { s1: snapshotEvent([userEntry("u1", "hello")], null) },
		},
	});
	await login(page);
	await openSession(page, api, "s1");
	await expect(page.locator('[data-testid="session-page"]')).toBeVisible();
	return api;
}

test("the composer footer shows the model, the preset, the budget, the context fill and the total usage", async ({
	page,
}) => {
	await openFooterPage(page);
	await expect(page.getByTestId("composer-model")).toHaveText("faux/faux-1");
	await expect(page.getByTestId("composer-rules")).toHaveText("Ask");
	await expect(page.getByTestId("composer-budget")).toHaveText("Budget 12.3K");
	await expect(page.getByTestId("composer-context")).toHaveText("50%");
	await expect(page.getByTestId("composer-usage")).toHaveText("1.5M");
	await expect(page.getByTestId("composer-budget")).toHaveAttribute("title", "12,345 tokens left");
	await expect(page.getByTestId("composer-context")).toHaveAttribute("title", "64,000 / 128,000");
	await expect(page.getByTestId("composer-usage")).toHaveAttribute("title", "1,500,000 tokens in total");
	// The header keeps only the title and the share button.
	await expect(page.getByTestId("session-header").getByTestId("session-title")).toBeVisible();
	await expect(page.getByTestId("session-header").getByTestId("composer-budget")).toHaveCount(0);
});

/** The page and the footer row do not scroll sideways. */
async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => {
		const root = document.documentElement;
		const footer = document.querySelector('[data-testid="composer-footer"]');
		return {
			page: root.scrollWidth - root.clientWidth,
			footer: footer === null ? 0 : footer.scrollWidth - footer.clientWidth,
		};
	});
	expect(overflow.page).toBeLessThanOrEqual(0);
	expect(overflow.footer).toBeLessThanOrEqual(0);
}

test("at 390 px stop and send stay visible, the optional counters hide, and nothing overflows", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openFooterPage(page, { state: "running" });
	await expect(page.getByTestId("abort-session")).toBeVisible();
	await expect(page.getByTestId("composer-send")).toBeVisible();
	await expect(page.getByTestId("composer-model")).toBeVisible();
	await expect(page.getByTestId("composer-rules")).toBeVisible();
	// There is no room for a counter next to the model, the rules and the two buttons.
	await expect(page.getByTestId("composer-usage")).toBeHidden();
	await expect(page.getByTestId("composer-context")).toBeHidden();
	await expect(page.getByTestId("composer-budget")).toBeHidden();
	await expectNoHorizontalOverflow(page);
});

test("at 768 px the budget is visible, and at 1440 px every counter fits", async ({ page }) => {
	await page.setViewportSize({ width: 768, height: 900 });
	await openFooterPage(page);
	// Below `lg` the session takes the whole width instead of a third column: the list is behind the back button.
	await expect(page.getByTestId("session-list-slot")).toBeHidden();
	await expect(page.getByTestId("session-back")).toBeVisible();
	await expect(page.getByTestId("composer-model")).toBeVisible();
	await expect(page.getByTestId("composer-rules")).toBeVisible();
	await expect(page.getByTestId("composer-budget")).toBeVisible();
	await expect(page.getByTestId("composer-send")).toBeVisible();
	await expectNoHorizontalOverflow(page);

	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(page.getByTestId("composer-usage")).toBeVisible();
	await expect(page.getByTestId("composer-context")).toBeVisible();
	await expect(page.getByTestId("composer-budget")).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test("the children bar counts the direct children and opens the tree, expanding nested children lazily", async ({
	page,
}) => {
	const root = sessionListItem({ id: "s1", title: "Parent", updatedAt: new Date().toISOString() });
	const child = sessionListItem({
		id: "c1",
		title: "Child one",
		parentSessionId: "s1",
		state: "running",
		updatedAt: new Date().toISOString(),
	});
	const awaiting = sessionListItem({
		id: "c2",
		title: "Child two",
		parentSessionId: "s1",
		state: "awaiting",
		waitingKind: "approval",
		updatedAt: new Date().toISOString(),
	});
	const grandchild = sessionListItem({
		id: "g1",
		title: "Grandchild",
		parentSessionId: "c1",
		updatedAt: new Date().toISOString(),
	});
	const api = await mockApi(page, {
		state: {
			sessions: [root, child, awaiting, grandchild],
			details: {
				s1: sessionView(root),
				c1: sessionView(child, { parentSessionId: "s1" } as never),
				c2: sessionView(awaiting, { parentSessionId: "s1" } as never),
				g1: sessionView(grandchild, { parentSessionId: "c1" } as never),
			},
			children: { s1: [child, awaiting], c1: [grandchild] },
			events: {
				s1: snapshotEvent([userEntry("u1", "delegate")], null),
				g1: snapshotEvent([userEntry("u1", "nested")], null),
			},
		},
	});
	await login(page);
	await openSession(page, api, "s1");

	const bar = page.getByTestId("children-bar");
	await expect(bar).toContainText("2 subagents");
	await expect(bar).toContainText("1 running");
	await expect(bar).toContainText("1 awaiting");
	// The tree is lazy: the first level is only in the DOM once the bar is opened.
	await expect(page.getByTestId("child-session")).toHaveCount(0);
	await bar.click();
	await expect(page.getByTestId("children-popover")).toBeVisible();
	await expect(page.getByTestId("child-session")).toHaveCount(2);
	await expect(page.getByTestId("child-session").first()).toContainText("Child one");

	// Expanding a node asks for its own children.
	await page.getByTestId("children-expand").first().click();
	await expect(page.getByTestId("child-session")).toHaveCount(3);
	await expect(page.getByTestId("children-tree").getByText("Grandchild")).toBeVisible();
	expect(api.state.requests.some((request) => request.url === "/api/sessions/c1/children")).toBe(true);

	// A nested node links to its session.
	await page.getByTestId("child-session").filter({ hasText: "Grandchild" }).click();
	await expect(page).toHaveURL(/\/sessions\/g1$/);
	await expect(page.locator('[data-testid="session-page"]')).toHaveAttribute("data-session-id", "g1");
});

test("a session without children shows no children bar", async ({ page }) => {
	await openFooterPage(page);
	await expect(page.getByTestId("children-bar")).toHaveCount(0);
});

import { expect, type Page, test } from "@playwright/test";
import { login, mockApi, openSession, sessionListItem, sessionView, snapshotEvent, userEntry } from "./helpers";

const MODELS = [
	{
		provider: "faux",
		modelId: "faux-1",
		name: "Faux One",
		contextWindow: 128_000,
		thinkingLevels: ["off"],
		input: ["text"],
	},
];

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

test("the composer shows the model, the rule preset and the budget in the footer, and the context and usage below it", async ({
	page,
}) => {
	await openFooterPage(page);
	await expect(page.getByTestId("composer-model")).toHaveText("faux/faux-1");
	await expect(page.getByTestId("composer-rules")).toHaveText("Ask");
	await expect(page.getByTestId("composer-budget")).toHaveText("12.3K");
	await expect(page.getByTestId("composer-context")).toHaveText("50%");
	await expect(page.getByTestId("composer-usage")).toHaveText("1.5M");
	await expect(page.getByTestId("composer-budget")).toHaveAttribute("title", "12,345 tokens left");
	await expect(page.getByTestId("composer-context")).toHaveAttribute("title", "64,000 / 128,000");
	await expect(page.getByTestId("composer-usage")).toHaveAttribute("title", "1,500,000 tokens in total");
	// The header keeps only the title and the share button.
	await expect(page.getByTestId("session-header").getByTestId("session-title")).toBeVisible();
	await expect(page.getByTestId("session-header").getByTestId("composer-budget")).toHaveCount(0);
});

test("the model and rule preset controls open their option lists directly", async ({ page }) => {
	await openFooterPage(page);
	const heights = await page.evaluate(() => {
		const height = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.offsetHeight;
		return { model: height("composer-model"), rules: height("composer-rules"), budget: height("composer-budget") };
	});
	expect(Math.abs((heights.model ?? 0) - (heights.budget ?? 0))).toBeLessThanOrEqual(1);
	expect(Math.abs((heights.rules ?? 0) - (heights.budget ?? 0))).toBeLessThanOrEqual(1);

	const list = page.locator('[data-slot="select-content"]:visible');
	await page.getByTestId("composer-model").click();
	await expect(list).toBeVisible();
	await expect(list.getByRole("option", { name: "Faux One" })).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(list).toHaveCount(0);

	await page.getByTestId("composer-rules").click();
	await expect(list).toBeVisible();
	await expect(list.getByRole("option")).toHaveText(["Ask", "Auto Review", "Yolo"]);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const iconOffsets = await list.locator('[data-slot="select-item"]').evaluateAll((items) =>
		items.map((item) => {
			const row = item.getBoundingClientRect();
			const icon = item.querySelector("svg")?.getBoundingClientRect();
			return icon === undefined ? 0 : Math.abs(icon.top + icon.height / 2 - (row.top + row.height / 2));
		}),
	);
	expect(iconOffsets.every((offset) => offset <= 0.5)).toBe(true);
});

test("the composer is one rounded box that grows with its content up to half the transcript", async ({ page }) => {
	await openFooterPage(page);
	const input = page.getByTestId("composer-input");
	const initial = await input.evaluate((element) => {
		const style = getComputedStyle(element);
		const box = element.parentElement;
		const header = document.querySelector('[data-testid="session-header"]');
		const transcript = document.querySelector('[data-slot="transcript"]');
		return {
			height: element.getBoundingClientRect().height,
			resize: style.resize,
			inputBorder: style.borderTopWidth,
			boxBorder: box === null ? null : getComputedStyle(box).borderTopWidth,
			boxRadius: box === null ? null : getComputedStyle(box).borderRadius,
			headerBorder: header === null ? null : getComputedStyle(header).borderBottomWidth,
			maxHeight: transcript === null ? 0 : transcript.clientHeight / 2,
		};
	});
	expect(initial.inputBorder).toBe("0px");
	expect(initial.boxBorder).toBe("1px");
	expect(initial.boxRadius).not.toBe("0px");
	expect(initial.headerBorder).toBe("0px");
	expect(initial.resize).toBe("none");
	expect(initial.height).toBeLessThan(60);

	await input.fill(Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n"));
	await page.waitForTimeout(200);
	const grown = await input.evaluate((element) => ({
		height: element.getBoundingClientRect().height,
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
	}));
	expect(grown.height).toBeGreaterThan(initial.height + 40);
	expect(grown.height).toBeLessThanOrEqual(initial.maxHeight + 1);
	expect(grown.scrollHeight).toBeGreaterThan(grown.clientHeight);
});

test("the context and total usage sit centered on their own row under the composer box", async ({ page }) => {
	await openFooterPage(page);
	const geometry = await page.evaluate(() => {
		const meta = document.querySelector<HTMLElement>('[data-testid="composer-meta"]');
		const input = document.querySelector<HTMLElement>('[data-testid="composer-input"]');
		const box = input?.parentElement;
		if (!meta || !box) return null;
		const metaRect = meta.getBoundingClientRect();
		const boxRect = box.getBoundingClientRect();
		return {
			gap: metaRect.top - boxRect.bottom,
			centerDelta: Math.abs(metaRect.left + metaRect.width / 2 - (boxRect.left + boxRect.width / 2)),
			justify: getComputedStyle(meta).justifyContent,
			containsContext: meta.contains(document.querySelector('[data-testid="composer-context"]')),
			containsUsage: meta.contains(document.querySelector('[data-testid="composer-usage"]')),
		};
	});
	expect(geometry).not.toBeNull();
	expect(geometry?.gap).toBeGreaterThan(0);
	expect(geometry?.gap).toBeLessThan(12);
	expect(geometry?.centerDelta).toBeLessThan(1);
	expect(geometry?.justify).toBe("center");
	expect(geometry?.containsContext).toBe(true);
	expect(geometry?.containsUsage).toBe(true);
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

test("at 390 px the merged stop/send button switches with the draft and nothing overflows", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openFooterPage(page, { state: "running" });
	await expect(page.getByTestId("abort-session")).toBeVisible();
	await expect(page.getByTestId("composer-send")).toHaveCount(0);
	await page.getByTestId("composer-input").fill("steer");
	await expect(page.getByTestId("composer-send")).toBeVisible();
	await expect(page.getByTestId("abort-session")).toHaveCount(0);
	await page.getByTestId("composer-input").fill("");
	await expect(page.getByTestId("composer-model")).toBeVisible();
	await expect(page.getByTestId("composer-rules")).toBeVisible();
	await expect(page.getByTestId("composer-usage")).toBeVisible();
	await expect(page.getByTestId("composer-context")).toBeVisible();
	await expect(page.getByTestId("composer-budget")).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test("at 768 px and 1440 px the footer and the meta row keep their contents", async ({ page }) => {
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
	const geometry = await page.evaluate(() => {
		const shell = document.querySelector<HTMLElement>('[data-testid="children-bar-shell"]');
		const input = document.querySelector<HTMLElement>('[data-testid="composer-input"]');
		const box = input?.parentElement;
		if (!shell || !box) return null;
		const shellStyle = getComputedStyle(shell);
		return {
			widthDelta: Math.abs(shell.getBoundingClientRect().width - box.getBoundingClientRect().width),
			gap: box.getBoundingClientRect().top - shell.getBoundingClientRect().bottom,
			radius: shellStyle.borderRadius,
			border: shellStyle.borderTopWidth,
			shadow: shellStyle.boxShadow,
			specialColors: document.querySelectorAll(
				'[data-testid="children-bar"] .text-info, [data-testid="children-bar"] .text-warn',
			).length,
		};
	});
	expect(geometry).not.toBeNull();
	expect(geometry?.widthDelta).toBeLessThanOrEqual(1);
	expect(geometry?.gap).toBeLessThanOrEqual(6);
	expect(geometry?.radius).not.toBe("0px");
	expect(geometry?.border).toBe("0px");
	expect(geometry?.shadow).toBe("none");
	expect(geometry?.specialColors).toBe(0);
	await expect(bar).toContainText("2 subagents");
	await expect(bar).toContainText("1 running");
	await expect(bar).toContainText("1 awaiting");
	await expect(bar.locator(".lucide-chevron-up")).toHaveCount(0);
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

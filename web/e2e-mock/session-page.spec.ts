import type { AvailableModel, JobView } from "@crh/api";
import { expect, type Page, test } from "@playwright/test";
import { login, mockApi, openSession, sessionListItem, sessionView, snapshotEvent, userEntry } from "./helpers";

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
	await expect(page.getByTestId("composer-model")).toHaveText("Faux One");
	await expect(page.getByTestId("composer-rules")).toHaveText("Ask");
	await expect(page.getByTestId("composer-budget")).toHaveText("12.3K");
	await expect(page.getByTestId("composer-context")).toHaveText("50%");
	await expect(page.getByTestId("composer-usage")).toHaveText("1.5M");
	await expect(page.getByTestId("composer-budget")).toHaveAttribute("title", "Used 1,000 · 12,345 left");
	await expect(page.getByTestId("composer-context")).toHaveAttribute("title", "64,000 / 128,000");
	await expect(page.getByTestId("composer-usage")).toHaveAttribute("title", "1,500,000 tokens in total");
	// The header keeps the title, the extensions button when the session has extensions, and the share button.
	await expect(page.getByTestId("session-header").getByTestId("session-title")).toBeVisible();
	await expect(page.getByTestId("session-extensions")).toHaveCount(0);
	await expect(page.getByTestId("session-header").getByTestId("composer-budget")).toHaveCount(0);
});

test("the owner turns a session extension off from the header", async ({ page }) => {
	const api = await openFooterPage(page, {
		extensions: [
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
		],
	});
	const button = page.getByTestId("session-extensions");
	await expect(button).toHaveAttribute("aria-label", "Extensions: 2/2");
	await button.click();
	const dialog = page.getByTestId("extensions-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Alpha tools");

	await dialog.getByRole("checkbox").first().click();
	await expect
		.poll(
			() =>
				api.state.requests.find((request) => request.method === "PATCH" && request.url === "/api/sessions/s1")?.body,
		)
		.toEqual({ disabledExtensions: ["alpha"] });
	await expect(button).toHaveAttribute("aria-label", "Extensions: 1/2");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

test("a share viewer does not see the extensions button", async ({ page }) => {
	await openFooterPage(page, {
		relationship: "shared",
		extensions: [
			{
				name: "alpha",
				kind: "mcp",
				description: null,
				enabled: true,
				available: true,
				listDirectly: false,
			},
		],
	});
	await expect(page.getByTestId("session-header")).toBeVisible();
	await expect(page.getByTestId("session-extensions")).toHaveCount(0);
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

test("while a message is sending the composer box keeps one background", async ({ page }) => {
	await openFooterPage(page);
	// The send never answers, so the textarea stays disabled.
	await page.route("**/api/sessions/s1/**", (route) =>
		route.request().method() === "POST" ? undefined : route.fallback(),
	);
	const input = page.getByTestId("composer-input");
	await input.fill("hello there");
	await input.press("Enter");
	await expect(input).toBeDisabled();
	// The textarea is only the top of the bordered box: its own disabled fill would grey just that part. The
	// fill fades in (transition-colors), so read it once the transitions have finished.
	const background = await input.evaluate(async (element) => {
		await Promise.all(element.getAnimations().map((animation) => animation.finished));
		return getComputedStyle(element).backgroundColor;
	});
	expect(background).toMatch(/^rgba\(0, 0, 0, 0\)$|\/ 0\)$/);
});

test("selected text stays visible on the user's bubble and elsewhere follows the theme", async ({ page }) => {
	await openFooterPage(page);
	const colors = await page.getByTestId("user-message").evaluate((bubble) => {
		const style = getComputedStyle(bubble);
		const selection = getComputedStyle(bubble, "::selection");
		const page = getComputedStyle(document.body, "::selection");
		return {
			bubble: style.backgroundColor,
			text: style.color,
			selectionBackground: selection.backgroundColor,
			selectionText: selection.color,
			pageSelection: page.backgroundColor,
		};
	});
	// The bubble is painted in the primary colour, so its selection is inverted rather than primary-tinted.
	expect(colors.selectionBackground).toBe(colors.text);
	expect(colors.selectionText).toBe(colors.bubble);
	// Everywhere else the selection is a translucent tint of the theme, not the system highlight.
	expect(colors.pageSelection).toMatch(/\/ 0\.2\d*\)$/);
});

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

const jobView = (overrides: Partial<JobView> & Pick<JobView, "id" | "resource">): JobView => ({
	kind: "exec",
	state: "running",
	wait: null,
	outcome: null,
	action: { type: "exec", command: "echo job" },
	sessionId: "s1",
	createdAt: new Date().toISOString(),
	settledAt: null,
	...overrides,
});

test("the background bar counts active jobs and opens the tree, expanding nested jobs lazily", async ({ page }) => {
	const root = sessionListItem({ id: "s1", title: "Parent", updatedAt: new Date().toISOString() });
	const child = sessionListItem({
		id: "c1",
		title: "Child one",
		state: "running",
		updatedAt: new Date().toISOString(),
	});
	const call = jobView({
		id: "call-1",
		kind: "call",
		state: "waiting",
		wait: "approval",
		action: { type: "extension_tool", extension: "github", tool: "create_issue" },
		resource: { type: "external_call", id: "call-1" },
	});
	const subagent = jobView({
		id: "subagent-1",
		kind: "subagent",
		action: { type: "subagent", task: "Delegate to child" },
		resource: { type: "session", id: "c1" },
	});
	const settled = jobView({
		id: "exec-2",
		kind: "exec",
		state: "settled",
		outcome: { kind: "succeeded", failed: false },
		action: { type: "exec", command: "Settled job" },
		resource: { type: "task", id: "t2" },
		settledAt: new Date().toISOString(),
	});
	const nested = jobView({
		id: "exec-9",
		action: { type: "exec", command: "Nested work" },
		resource: { type: "task", id: "t9" },
		sessionId: "c1",
	});
	const api = await mockApi(page, {
		state: {
			sessions: [root, child],
			details: {
				s1: sessionView(root),
				c1: sessionView(child, { parentSessionId: "s1" } as never),
			},
			jobs: { s1: [settled, call, subagent], c1: [nested] },
			events: {
				s1: snapshotEvent([userEntry("u1", "delegate")], null),
				c1: snapshotEvent([userEntry("c1-u1", "nested")], null),
			},
		},
	});
	await login(page);
	await openSession(page, api, "s1");

	const bar = page.getByTestId("background-bar");
	await expect(bar).toBeVisible();
	const geometry = await page.evaluate(() => {
		const shell = document.querySelector<HTMLElement>('[data-testid="background-bar-shell"]');
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
				'[data-testid="background-bar"] .text-info, [data-testid="background-bar"] .text-warn',
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
	// Only waiting and running jobs count; the settled one has left the bar.
	await expect(bar).toContainText("2 background jobs");
	await expect(bar).toContainText("1 running");
	await expect(bar).toContainText("1 waiting");
	// The tree is lazy: the nested level is fetched only when its row is expanded.
	await expect(page.getByTestId("background-tree")).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Nested work" })).toHaveCount(0);
	await bar.click();
	await expect(page.getByTestId("background-popover")).toBeVisible();
	await expect(page.getByTestId("background-tree").getByText("Delegate to child")).toBeVisible();
	await expect(page.getByTestId("background-tree").getByText("github/create_issue")).toBeVisible();
	await expect(page.getByTestId("background-tree").getByText("Settled job")).toHaveCount(0);
	// The extension call has no page: it offers Stop, the subagent row links to its session.
	await expect(page.getByTestId("background-tree").getByTestId("background-job-stop")).toHaveCount(1);
	await expect(page.getByRole("link", { name: "Delegate to child" })).toHaveAttribute("href", "/sessions/c1");
	expect(api.state.requests.some((request) => request.url.startsWith("/api/jobs?session=c1"))).toBe(false);

	await page.getByTestId("background-job-expand").first().click();
	await expect(page.getByTestId("background-tree").getByText("Nested work")).toBeVisible();
	expect(api.state.requests.some((request) => request.url.startsWith("/api/jobs?session=c1"))).toBe(true);
	await page.getByRole("link", { name: "Nested work" }).click();
	await expect(page).toHaveURL(/\/tasks\/t9$/);
});

test("long job actions stay inside the background popover and the mobile sheet", async ({ page }) => {
	const longAction = `systemctl restart ${"a-very-long-service-name-".repeat(10)}`;
	const nestedAction = `journalctl -u ${"another-long-service-name-".repeat(10)}`;
	const root = sessionListItem({ id: "s1", title: "Parent", updatedAt: new Date().toISOString() });
	const child = sessionListItem({
		id: "c1",
		title: "Child one",
		state: "running",
		updatedAt: new Date().toISOString(),
	});
	const subagent = jobView({
		id: "subagent-1",
		kind: "subagent",
		action: { type: "subagent", task: longAction },
		resource: { type: "session", id: "c1" },
	});
	const nested = jobView({
		id: "exec-9",
		action: { type: "exec", command: nestedAction },
		resource: { type: "task", id: "t9" },
		sessionId: "c1",
	});
	const api = await mockApi(page, {
		state: {
			sessions: [root, child],
			details: { s1: sessionView(root), c1: sessionView(child, { parentSessionId: "s1" } as never) },
			jobs: { s1: [subagent], c1: [nested] },
			events: {
				s1: snapshotEvent([userEntry("u1", "delegate")], null),
				c1: snapshotEvent([userEntry("c1-u1", "nested")], null),
			},
		},
	});
	await login(page);
	await openSession(page, api, "s1");

	// At 390 px the bar opens as a bottom sheet; the nested level's depth padding must fit too.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId("background-bar").click();
	await expect(page.getByTestId("background-sheet")).toBeVisible();
	await page.getByTestId("background-job-expand").first().click();
	await expect(page.getByTestId("background-tree").getByRole("link", { name: nestedAction })).toBeVisible();
	const mobile = await page.evaluate(() => {
		const tree = document.querySelector<HTMLElement>('[data-testid="background-tree"]');
		const trigger = document.querySelector<HTMLElement>('[data-testid="background-bar"]');
		if (!tree || !trigger) return null;
		return {
			tree: tree.scrollWidth - tree.clientWidth,
			trigger: trigger.scrollWidth - trigger.clientWidth,
			treeRight: tree.getBoundingClientRect().right,
			viewport: window.innerWidth,
		};
	});
	expect(mobile).not.toBeNull();
	expect(mobile?.tree).toBeLessThanOrEqual(0);
	expect(mobile?.trigger).toBeLessThanOrEqual(0);
	expect(mobile?.treeRight).toBeLessThanOrEqual(390);
	expect(mobile?.viewport).toBe(390);
	// The action truncates (its title keeps the whole text) rather than widening the tree.
	const truncated = await page
		.getByTestId("background-job-link")
		.first()
		.evaluate((element) => ({
			overflow: element.scrollWidth - element.clientWidth,
			title: element.getAttribute("title"),
		}));
	expect(truncated.overflow).toBeGreaterThan(0);
	expect(truncated.title).toBe(longAction);

	await page.keyboard.press("Escape");
	await expect(page.getByTestId("background-sheet")).toBeHidden();

	// On desktop the popover stays inside the viewport.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.getByTestId("background-bar").click();
	const popover = page.getByTestId("background-popover");
	await expect(popover).toBeVisible();
	await page.getByTestId("background-job-expand").first().click();
	await expect(page.getByTestId("background-tree").getByRole("link", { name: nestedAction })).toBeVisible();
	const desktop = await page.evaluate(() => {
		const tree = document.querySelector<HTMLElement>('[data-testid="background-tree"]');
		const popover = document.querySelector<HTMLElement>('[data-testid="background-popover"]');
		if (!tree || !popover) return null;
		const rect = popover.getBoundingClientRect();
		return {
			tree: tree.scrollWidth - tree.clientWidth,
			popover: popover.scrollWidth - popover.clientWidth,
			left: rect.left,
			right: rect.right,
			viewport: window.innerWidth,
		};
	});
	expect(desktop).not.toBeNull();
	expect(desktop?.tree).toBeLessThanOrEqual(0);
	expect(desktop?.popover).toBeLessThanOrEqual(0);
	expect(desktop?.left).toBeGreaterThanOrEqual(0);
	expect(desktop?.right).toBeLessThanOrEqual(1440);
	expect(desktop?.viewport).toBe(1440);
});

test("a session without active jobs shows no background bar", async ({ page }) => {
	await openFooterPage(page);
	await expect(page.getByTestId("background-bar")).toHaveCount(0);
});

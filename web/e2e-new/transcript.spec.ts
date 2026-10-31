import { expect, type Page, test } from "@playwright/test";
import {
	type ApiMock,
	assistantEntry,
	login,
	makeTranscript,
	mockApi,
	openSession,
	sessionListItem,
	snapshotEvent,
	toolEntries,
	userEntry,
} from "./helpers";

const SCROLLER = '[data-testid="transcript-scroller"]';

async function distance(page: Page): Promise<number> {
	return page.evaluate((selector) => {
		const element = document.querySelector<HTMLElement>(selector);
		if (!element) return Number.POSITIVE_INFINITY;
		return element.scrollHeight - element.scrollTop - element.clientHeight;
	}, SCROLLER);
}

async function waitForBottom(page: Page): Promise<void> {
	await expect.poll(() => distance(page), { timeout: 20_000, intervals: [50, 100, 200] }).toBeLessThanOrEqual(2);
	await expect.poll(() => page.locator(SCROLLER).getAttribute("data-at-bottom"), { timeout: 5_000 }).toBe("true");
}

interface Anchor {
	id: string;
	top: number;
}

async function firstVisibleAnchor(page: Page): Promise<Anchor | null> {
	return page.evaluate((selector) => {
		const element = document.querySelector<HTMLElement>(selector);
		if (!element) return null;
		const top = element.getBoundingClientRect().top;
		for (const row of element.querySelectorAll<HTMLElement>('[data-testid="message"]')) {
			if (row.getBoundingClientRect().bottom <= top + 1) continue;
			const id = row.getAttribute("data-message-id");
			return id === null ? null : { id, top: row.getBoundingClientRect().top };
		}
		return null;
	}, SCROLLER);
}

async function messageTop(page: Page, id: string): Promise<number | null> {
	return page.evaluate(
		({ selector, messageId }) => {
			const element = document.querySelector<HTMLElement>(selector);
			const row = element?.querySelector<HTMLElement>(
				`[data-testid="message"][data-message-id="${CSS.escape(messageId)}"]`,
			);
			return row ? row.getBoundingClientRect().top : null;
		},
		{ selector: SCROLLER, messageId: id },
	);
}

async function emitDelta(api: ApiMock, sessionId: string, delta: string, index = 0): Promise<void> {
	await api.emit(`/api/sessions/${sessionId}/events`, "events", [
		{ type: "message_update", changes: [{ type: "text_delta", contentIndex: index, delta }] },
	]);
}

function transcriptFixture() {
	const entries = makeTranscript(60);
	// A tool card in the middle, so the resize test can find one on screen.
	entries.splice(30, 0, ...toolEntries("tool-1", "uname -a", '{"state":"exited","exit_code":0}'));
	return entries;
}

async function openChat(page: Page, api: ApiMock, sessionId = "s1"): Promise<void> {
	await openSession(page, api, sessionId);
	await expect(page.locator(SCROLLER)).toBeVisible();
	await waitForBottom(page);
}

function sessionState() {
	const sessions = [
		sessionListItem({ id: "s1", title: "Investigate auth-gateway", updatedAt: "2026-01-02T00:00:00.000Z" }),
		sessionListItem({ id: "s2", title: "Audit ingress-nginx", updatedAt: "2026-01-01T00:00:00.000Z" }),
	];
	const events = { s1: snapshotEvent(transcriptFixture(), "h1"), s2: snapshotEvent(makeTranscript(5, "x"), null) };
	return { sessions, events };
}

test("1. opening a session lands at the bottom with the newest message visible", async ({ page }) => {
	const fixture = sessionState();
	const api = await mockApi(page, { state: fixture });
	await login(page);
	await openChat(page, api);

	expect(await page.locator(SCROLLER).getAttribute("data-at-bottom")).toBe("true");
	expect(await distance(page)).toBeLessThanOrEqual(2);
	const last = await page.evaluate((selector) => {
		const element = document.querySelector<HTMLElement>(selector);
		const rows = element?.querySelectorAll<HTMLElement>('[data-testid="message"]') ?? [];
		const row = rows[rows.length - 1];
		if (!element || !row) return null;
		const container = element.getBoundingClientRect();
		const rect = row.getBoundingClientRect();
		return {
			id: row.getAttribute("data-message-id"),
			visible: rect.top < container.bottom && rect.bottom > container.top,
		};
	}, SCROLLER);
	expect(last).not.toBeNull();
	expect(last?.visible).toBe(true);
	expect(last?.id).toContain("e");
});

test("2. loading older history keeps the reading anchor within 2 px", async ({ page }) => {
	const fixture = sessionState();
	const api = await mockApi(page, {
		state: {
			...fixture,
			olderEntries: { s1: { entries: makeTranscript(20, "o"), historyCursor: null } },
		},
	});
	await login(page);
	await openChat(page, api);
	const before = await page.locator(SCROLLER).getAttribute("data-loaded-count");

	await page.locator(SCROLLER).hover();
	for (let index = 0; index < 30; index++) {
		const top = await page.evaluate(
			(selector) => document.querySelector<HTMLElement>(selector)?.scrollTop ?? 0,
			SCROLLER,
		);
		if (top < 1_200) break;
		await page.mouse.wheel(0, -2_500);
		await page.waitForTimeout(40);
	}
	const requestPromise = page.waitForRequest((request) => request.url().includes("/entries?"));
	await page.evaluate((selector) => {
		const element = document.querySelector<HTMLElement>(selector);
		if (element) element.scrollTop = 0;
	}, SCROLLER);
	await requestPromise;

	await expect
		.poll(() => page.locator(SCROLLER).getAttribute("data-loaded-count"), { timeout: 10_000 })
		.not.toBe(before);
	await page.waitForTimeout(600);

	const recorded = await page.evaluate((selector) => {
		const element = document.querySelector<HTMLElement>(selector);
		return { id: element?.dataset.prependAnchorId, top: Number(element?.dataset.prependAnchorTop) };
	}, SCROLLER);
	expect(recorded.id).toBeTruthy();
	const after = await messageTop(page, recorded.id as string);
	expect(after).not.toBeNull();
	expect(Math.abs((after as number) - recorded.top)).toBeLessThanOrEqual(2);
});

test("3. streaming at the bottom stays pinned", async ({ page }) => {
	const fixture = sessionState();
	const api = await mockApi(page, { state: fixture });
	await login(page);
	await openChat(page, api);

	await api.emit("/api/sessions/s1/events", "events", [
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }] },
	]);
	for (let index = 0; index < 8; index++) {
		await emitDelta(
			api,
			"s1",
			`Chunk ${index}. ${"The stream keeps growing while the reader is at the bottom. ".repeat(4)}\n\n`,
		);
		await page.waitForTimeout(120);
	}
	const samples: number[] = [];
	for (let index = 0; index < 4; index++) {
		samples.push(await distance(page));
		await page.waitForTimeout(120);
	}
	for (const sample of samples) expect(sample).toBeLessThanOrEqual(2);
	expect(await page.locator(SCROLLER).getAttribute("data-at-bottom")).toBe("true");

	// A committed message after the stream is pinned too.
	await api.emit("/api/sessions/s1/events", "events", [
		{ type: "message_end", entry: assistantEntry("e-new", "A final message after the stream") },
	]);
	await expect.poll(() => page.locator(SCROLLER).getAttribute("data-loaded-count")).toBe("62");
	await page.waitForTimeout(300);
	expect(await distance(page)).toBeLessThanOrEqual(2);
});

test("4. scrolling up freezes the view and jump-to-latest resumes following", async ({ page }) => {
	const fixture = sessionState();
	const api = await mockApi(page, { state: fixture });
	await login(page);
	await openChat(page, api);

	await page.locator(SCROLLER).hover();
	await page.mouse.wheel(0, -1_500);
	await page.waitForTimeout(300);
	expect(await distance(page)).toBeGreaterThan(400);
	await expect(page.getByTestId("jump-to-latest")).toBeVisible();

	const anchor = await firstVisibleAnchor(page);
	expect(anchor).not.toBeNull();
	await api.emit("/api/sessions/s1/events", "events", [
		{ type: "message_start", message: { role: "assistant", content: [] } },
		{ type: "message_update", changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }] },
	]);
	for (let index = 0; index < 6; index++) {
		await emitDelta(api, "s1", `More streamed text ${index}.\n\n`);
		await page.waitForTimeout(120);
	}
	const after = await messageTop(page, (anchor as Anchor).id);
	expect(after).not.toBeNull();
	expect(Math.abs((after as number) - (anchor as Anchor).top)).toBeLessThanOrEqual(2);

	await page.getByTestId("jump-to-latest").click();
	await waitForBottom(page);
	await expect(page.getByTestId("jump-to-latest")).toBeHidden();

	await emitDelta(api, "s1", "Following again after the jump.\n\n");
	await page.waitForTimeout(400);
	expect(await distance(page)).toBeLessThanOrEqual(2);
});

test("5. expanding a tool card does not move the content above it", async ({ page }) => {
	const fixture = sessionState();
	const api = await mockApi(page, { state: fixture });
	await login(page);
	await openChat(page, api);
	await page.locator(SCROLLER).hover();

	let tool: { id: string; box: { x: number; y: number; width: number; height: number } } | null = null;
	for (let attempt = 0; attempt < 80 && tool === null; attempt++) {
		tool = await page.evaluate((selector) => {
			const element = document.querySelector<HTMLElement>(selector);
			if (!element) return null;
			const container = element.getBoundingClientRect();
			for (const row of element.querySelectorAll<HTMLElement>('[data-testid="message"][data-kind="tool"]')) {
				const toggle = row.querySelector<HTMLElement>('[data-testid="tool-toggle"]');
				if (!toggle) continue;
				const rect = toggle.getBoundingClientRect();
				if (rect.top > container.top + 10 && rect.bottom < container.bottom - 10) {
					return {
						id: row.getAttribute("data-message-id") as string,
						box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
					};
				}
			}
			return null;
		}, SCROLLER);
		if (tool === null) {
			await page.mouse.wheel(0, -350);
			await page.waitForTimeout(100);
		}
	}
	expect(tool, "expected a tool card inside the viewport").not.toBeNull();

	await page.waitForTimeout(300);
	const anchor = await firstVisibleAnchor(page);
	expect(anchor).not.toBeNull();
	// Raw mouse click: a locator click would scroll the button into view first.
	const clicked = tool as { id: string; box: { x: number; y: number; width: number; height: number } };
	await page.mouse.click(clicked.box.x + clicked.box.width / 2, clicked.box.y + clicked.box.height / 2);
	await expect(page.locator(SCROLLER).locator('[data-testid="tool-output"]').first()).toBeVisible();
	await page.waitForTimeout(500);

	const after = await messageTop(page, (anchor as Anchor).id);
	expect(after).not.toBeNull();
	expect(Math.abs((after as number) - (anchor as Anchor).top)).toBeLessThanOrEqual(2);
});

test("6. switching sessions resets the scroll position", async ({ page }) => {
	const fixture = sessionState();
	const api = await mockApi(page, { state: fixture });
	await login(page);
	await openChat(page, api);
	const firstId = await page.locator(SCROLLER).getAttribute("data-first-id");

	await page.locator('[data-session-id="s2"]').click();
	await api.waitForStream("/api/sessions/s2/events");
	await api.emit("/api/sessions/s2/events", "events", fixture.events.s2);
	await waitForBottom(page);
	expect(await page.locator(SCROLLER).getAttribute("data-loaded-count")).toBe("5");
	expect(await page.locator(SCROLLER).getAttribute("data-first-id")).not.toBe(firstId);

	await page.locator('[data-session-id="s1"]').click();
	await api.waitForStream("/api/sessions/s1/events");
	await api.emit("/api/sessions/s1/events", "events", fixture.events.s1);
	await waitForBottom(page);
	expect(await distance(page)).toBeLessThanOrEqual(2);
});

test("7. Markdown in the transcript makes no remote request", async ({ page }) => {
	const malicious = [
		'<img src="https://evil.example/tracking.png" onerror="window.__crhPwned=1">',
		"![remote](https://evil.example/image.png)",
		"[bad](javascript:window.__crhPwned=2)",
		"<script>window.__crhPwned=3</script>",
		"Normal **text** with `code`.",
	].join("\n\n");
	const fixture = sessionState();
	const api = await mockApi(page, {
		state: {
			...fixture,
			events: {
				s1: snapshotEvent([userEntry("m1", "show me"), assistantEntry("m2", malicious)], null),
				s2: fixture.events.s2,
			},
		},
	});
	// A route-level counter is the strongest assertion: an image or any other
	// remote URL would have to pass through here before the browser fetches it.
	let remoteRequests = 0;
	await page.route("**/*", (route) => {
		const url = route.request().url();
		if (url.startsWith("http://localhost:4173") || url === "about:blank") return route.fallback();
		remoteRequests += 1;
		return route.abort();
	});
	await login(page);
	await openChat(page, api);
	await expect(page.getByTestId("safe-markdown").first()).toBeVisible();
	await page.waitForTimeout(800);

	expect(remoteRequests).toBe(0);
	expect(await page.evaluate(() => (window as unknown as { __crhPwned?: number }).__crhPwned)).toBeUndefined();
	expect(await page.locator('[data-testid="safe-markdown"] img').count()).toBe(0);
});

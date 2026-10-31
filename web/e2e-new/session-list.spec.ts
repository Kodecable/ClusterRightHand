import { expect, test } from "@playwright/test";
import { login, mockApi, sessionListItem, sessionView, snapshotEvent, userEntry } from "./helpers";

const SCROLLER = '[data-testid="session-list-scroller"]';

function manySessions() {
	const sessions = Array.from({ length: 55 }, (_, index) =>
		sessionListItem({
			id: `s-${index + 1}`,
			title: index === 4 ? "postgres failover check" : `Session ${index + 1}`,
			updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, 0) - index * 60_000).toISOString(),
		}),
	);
	return {
		sessions,
		details: Object.fromEntries(sessions.map((item) => [item.id, sessionView(item)])),
		events: Object.fromEntries(
			sessions.map((item) => [item.id, snapshotEvent([userEntry("u1", `Hello from ${item.title}`)], null)]),
		),
	};
}

test("the session list pages by cursor, searches and moves a streamed upsert to the top", async ({ page }) => {
	const fixture = manySessions();
	const api = await mockApi(page, { state: fixture });
	await login(page);

	await expect(page.locator(SCROLLER)).toBeVisible();
	await expect(page.locator('[data-session-id="s-1"]')).toBeVisible();
	expect(api.state.requests.some((request) => request.url.startsWith("/api/sessions?scope=mine"))).toBe(true);

	// Infinite loading: reaching the bottom asks for the next cursor page.
	await page.locator(SCROLLER).evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect
		.poll(() => api.state.requests.some((request) => request.url.includes("cursor=20")), { timeout: 10_000 })
		.toBe(true);

	// Server-side search is debounced.
	await page.getByTestId("session-search").fill("postgres");
	await expect
		.poll(() => api.state.requests.some((request) => request.url.includes("q=postgres")), { timeout: 10_000 })
		.toBe(true);
	await expect(page.locator('[data-session-id="s-5"]')).toBeVisible();

	// A stream upsert with the new state fields moves the row to the top.
	await page.getByTestId("session-search").fill("");
	await expect(page.locator('[data-session-id="s-1"]')).toBeVisible();
	await api.emit(
		"/api/sessions/stream",
		"upsert",
		sessionListItem({
			id: "s-5",
			title: "Promoted by the stream",
			state: "awaiting",
			waitingKind: "approval",
			updatedAt: new Date().toISOString(),
		}),
	);
	const top = page.locator("[data-session-id]").first();
	await expect(top).toHaveAttribute("data-session-id", "s-5");
	await expect(top).toHaveAttribute("data-state", "awaiting");
	await expect(top).toHaveAttribute("data-waiting-kind", "approval");
	await expect(top.getByText("Promoted by the stream")).toBeVisible();
});

test("Up/Down/Enter select a session with the keyboard", async ({ page }) => {
	const fixture = manySessions();
	const api = await mockApi(page, { state: fixture });
	await login(page);
	await expect(page.locator('[data-session-id="s-1"]')).toBeVisible();

	await page.locator(SCROLLER).focus();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");

	await expect(page).toHaveURL(/\/sessions\/s-3$/);
	await api.waitForStream("/api/sessions/s-3/events");
	await expect(page.locator('[data-testid="session-item"][data-session-id="s-3"]')).toHaveAttribute(
		"data-selected",
		"true",
	);
	await expect(page.locator('[data-testid="session-item"][aria-current="page"]')).toHaveCount(1);
});

test("scope tabs ask the server for the chosen scope and admins get All", async ({ page }) => {
	const fixture = manySessions();
	const api = await mockApi(page, { state: fixture });
	await login(page);
	await expect(page.getByTestId("scope-all")).toBeVisible();
	await page.getByTestId("scope-shared").click();
	await expect
		.poll(() => api.state.requests.some((request) => request.url.includes("scope=shared")), { timeout: 10_000 })
		.toBe(true);
	await expect(page.getByTestId("scope-shared")).toHaveAttribute("aria-pressed", "true");
});

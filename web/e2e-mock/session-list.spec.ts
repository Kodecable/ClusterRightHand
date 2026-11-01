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

test("a narrow screen shows the list as the main view and keeps the session's back button", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const fixture = manySessions();
	const api = await mockApi(page, { state: fixture });
	await login(page);

	// The list is the page, not an aside next to an empty "pick a session" panel.
	await expect(page.getByTestId("session-list-slot")).toBeVisible();
	await expect(page.getByText("No session selected")).toBeHidden();
	await expect(page.getByTestId("session-back")).toHaveCount(0);

	await page.locator('[data-session-id="s-2"]').click();
	await expect(page).toHaveURL(/\/sessions\/s-2$/);
	await api.waitForStream("/api/sessions/s-2/events");
	await expect(page.getByTestId("session-page")).toBeVisible();
	await expect(page.getByTestId("session-list-slot")).toBeHidden();
	await expect(page.getByTestId("session-header")).toBeVisible();

	await page.getByTestId("session-back").click();
	await expect(page).toHaveURL(/\/sessions$/);
	await expect(page.getByTestId("session-list-slot")).toBeVisible();
	await expect(page.getByTestId("session-page")).toBeHidden();
});

test("without models the disabled New button is explained in the list column", async ({ page }) => {
	const api = await mockApi(page);
	await login(page);
	await expect(page.getByTestId("new-session-button")).toBeDisabled();
	const hint = page.getByTestId("no-models-hint");
	await expect(hint).toContainText("No models are configured, so sessions cannot start.");
	await hint.getByRole("link", { name: "Configure a model provider" }).click();
	await expect(page).toHaveURL(/\/settings\/models$/);
	// The URL changes before the page's chunk renders, so wait for the request like the other tests here.
	await expect
		.poll(() => api.state.requests.some((request) => request.url === "/api/model-providers"), { timeout: 10_000 })
		.toBe(true);
});

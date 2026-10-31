import type { Browser, Page } from "@playwright/test";
import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { expect, login, newSession, test } from "./fixtures.ts";

test.use({ withAgent: true });

const MEMBER = { username: "mallory", password: "member-password-1" };

/** Logs a new browser context in as ADMIN and opens the sessions page. */
async function secondAdminPage(
	browser: Browser,
	crhs: InProcessCrhs,
): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext({ baseURL: crhs.url });
	const page = await context.newPage();
	await login(page);
	await expect(page.getByTestId("page-title")).toHaveText("Sessions");
	return { page, close: () => context.close() };
}

async function createSessionFor(crhs: InProcessCrhs, cookie: string, title: string): Promise<string> {
	const response = await fetch(`${crhs.url}/api/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify({
			title,
			preset: "ask",
			model: { provider: crhs.faux.provider.id, modelId: crhs.faux.getModel().id },
		}),
	});
	const json = (await response.json()) as { session?: { id: string } };
	if (response.status !== 201 || !json.session) throw new Error(`create session: ${response.status}`);
	return json.session.id;
}

async function loginCookie(crhs: InProcessCrhs, username: string, password: string): Promise<string> {
	const response = await fetch(`${crhs.url}/api/auth/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ username, password }),
	});
	const cookie = response.headers.get("set-cookie")?.match(/crh_session=[^;]+/)?.[0];
	if (response.status !== 200 || !cookie) throw new Error(`login ${username}: ${response.status}`);
	return cookie;
}

test("creating a session shows it in another browser's list through the stream", async ({
	adminPage: page,
	browser,
	crhs,
}) => {
	const other = await secondAdminPage(browser, crhs);
	try {
		await expect(other.page.getByTestId("session-list-scroller")).toBeVisible();
		await newSession(page, "Streamed session");
		// No reload on the other browser: the list's SSE stream patches the row in.
		await expect(other.page.locator('[data-testid="session-item"]', { hasText: "Streamed session" })).toBeVisible({
			timeout: 15_000,
		});
	} finally {
		await other.close();
	}
});

test("search and scope tabs ask the server and show only what matches", async ({ adminPage: page, browser, crhs }) => {
	const member = await crhs.api("/api/users", {
		body: { username: MEMBER.username, password: MEMBER.password, kind: "member" },
	});
	expect(member.status).toBe(201);
	const memberCookie = await loginCookie(crhs, MEMBER.username, MEMBER.password);
	await createSessionFor(crhs, memberCookie, "Member beta session");
	await createSessionFor(crhs, crhs.cookie, "Deploy the cluster");

	await page.goto("/sessions");
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Deploy the cluster" })).toBeVisible({
		timeout: 15_000,
	});

	// `mine` never shows the member's session; the admin's All tab does.
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toHaveCount(0);
	await page.getByTestId("scope-all").click();
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toBeVisible({
		timeout: 15_000,
	});

	// Server-side search is debounced; the list narrows to the matching title.
	await page.getByTestId("session-search").fill("deploy");
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Deploy the cluster" })).toBeVisible();
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toHaveCount(0);
	await page.getByTestId("session-search").fill("member beta");
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toBeVisible({
		timeout: 15_000,
	});
	await page.getByTestId("session-search").fill("");

	// A member gets no All tab, and their list starts at their own (empty) scope.
	const context = await browser.newContext({ baseURL: crhs.url });
	try {
		const memberPage = await context.newPage();
		await login(memberPage, MEMBER);
		await expect(memberPage.getByTestId("page-title")).toHaveText("Sessions");
		await expect(memberPage.getByTestId("scope-all")).toHaveCount(0);
		await expect(memberPage.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(memberPage.locator('[data-testid="session-item"]', { hasText: "Deploy the cluster" })).toHaveCount(0);
		await memberPage.getByTestId("scope-shared").click();
		await expect(memberPage.getByTestId("scope-shared")).toHaveAttribute("aria-pressed", "true");
	} finally {
		await context.close();
	}
});

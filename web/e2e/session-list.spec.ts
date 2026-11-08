import type { Browser, Page } from "@playwright/test";
import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { createSessionViaApi, expect, login, newSession, test } from "./fixtures.ts";

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

test("search and the visible scope show the caller's own and shared sessions", async ({
	adminPage: page,
	browser,
	crhs,
}) => {
	const member = await crhs.api("/api/users", {
		body: { username: MEMBER.username, password: MEMBER.password, kind: "member" },
	});
	expect(member.status).toBe(201);
	const memberId = member.json.user.id as string;
	const memberCookie = await loginCookie(crhs, MEMBER.username, MEMBER.password);
	await createSessionViaApi(crhs, {
		title: "Member beta session",
		message: "member session",
		cookie: memberCookie,
	});
	const adminSession = await createSessionViaApi(crhs, {
		title: "Deploy the cluster",
		message: "deploy the cluster",
	});

	await page.goto("/sessions");
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Deploy the cluster" })).toBeVisible({
		timeout: 15_000,
	});

	// The list is the owner-and-shared union even for an administrator: no All tab, so the member's
	// unshared session never appears.
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toHaveCount(0);
	await expect(page.getByTestId("scope-all")).toHaveCount(0);
	await expect(page.getByTestId("scope-mine")).toHaveCount(0);
	await expect(page.getByTestId("scope-shared")).toHaveCount(0);

	// Server-side search is debounced; the list narrows to the matching title.
	await page.getByTestId("session-search").fill("deploy");
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Deploy the cluster" })).toBeVisible();
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toHaveCount(0);
	await page.getByTestId("session-search").fill("member beta");
	await expect(page.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toHaveCount(0);
	await page.getByTestId("session-search").fill("");

	// Share the administrator's session with the member: their list is the union, so the row appears
	// without switching any scope tab.
	const shared = await crhs.api(`/api/sessions/${adminSession}/shares`, {
		method: "PUT",
		body: { granteeType: "user", granteeId: memberId, access: "view" },
	});
	expect(shared.status).toBe(200);

	const context = await browser.newContext({ baseURL: crhs.url });
	try {
		const memberPage = await context.newPage();
		await login(memberPage, MEMBER);
		await expect(memberPage.getByTestId("page-title")).toHaveText("Sessions");
		await expect(memberPage.locator('[data-testid="session-item"]', { hasText: "Member beta session" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(memberPage.locator('[data-testid="session-item"]', { hasText: "Deploy the cluster" })).toBeVisible({
			timeout: 15_000,
		});
	} finally {
		await context.close();
	}
});

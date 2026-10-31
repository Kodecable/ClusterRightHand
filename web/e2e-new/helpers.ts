import { expect, type Page } from "@playwright/test";
import type { ApprovalList, User } from "../src/lib/api/types";

export const USER: User = {
	id: "user-1",
	username: "ops",
	displayName: "Ada Ops",
	email: "ada@cluster.local",
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

const APPROVALS: ApprovalList = {
	tasks: [],
	taskGroups: [],
	authorizations: { tasks: [], taskGroups: [] },
	quotas: [
		{ sessionId: "s1", levelId: "root", title: "Nightly check", since: "2026-01-01T00:00:00Z", quota: 0, used: 100 },
		{ sessionId: "s2", levelId: "root", title: "Deploy check", since: "2026-01-01T00:00:00Z", quota: -5, used: 200 },
	],
};

export interface ApiMock {
	state: { loggedIn: boolean };
}

/**
 * A tiny fake crhs: `/api/me` answers 401 until the login route is called, the
 * approval list has two pending quota entries (the badge shows 2), and the
 * session stream stays open without sending anything.
 */
export async function mockApi(
	page: Page,
	{ loggedIn = false, user = USER }: { loggedIn?: boolean; user?: User } = {},
): Promise<ApiMock> {
	const state = { loggedIn };

	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();

		const json = (body: unknown, status = 200) =>
			route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

		// Keep the SSE connection open without events; the client stays connected.
		if (path === "/api/sessions/stream") return;

		if (path === "/api/me") {
			return state.loggedIn ? json({ user }) : json({ error: "unauthenticated" }, 401);
		}
		if (path === "/api/auth/login" && method === "POST") {
			const body = JSON.parse(request.postData() ?? "{}") as { username?: string; password?: string };
			if (body.username === "ops" && body.password === "secret") {
				state.loggedIn = true;
				return json({ user });
			}
			return json({ error: "invalid username or password" }, 401);
		}
		if (path === "/api/auth/logout") {
			state.loggedIn = false;
			return json({ ok: true });
		}
		if (path === "/api/auth/password") return json({ ok: true });
		if (path === "/api/approvals") return json(APPROVALS);
		if (path === "/api/nodes") return json({ nodes: [] });
		if (path === "/api/api-tokens") return json({ tokens: [] });
		if (path === "/api/models") return json({ models: [] });
		if (path === "/api/sessions") return json({ items: [], nextCursor: null });
		return json({});
	});

	return { state };
}

export async function login(page: Page): Promise<void> {
	await page.goto("/");
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
	await page.getByLabel("Username").fill("ops");
	await page.getByLabel("Password").fill("secret");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByTestId("page-title")).toHaveText("Sessions");
}

/** Open the user menu from the keyboard (focus the trigger, press Enter). */
export async function openUserMenuWithKeyboard(page: Page): Promise<void> {
	const trigger = page.getByTestId("user-menu-trigger");
	await trigger.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("user-menu")).toBeVisible();
}

export async function openMenuSection(page: Page, testId: string): Promise<void> {
	await page.getByTestId(testId).click();
}

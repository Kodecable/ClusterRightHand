import type { InProcessCrhs } from "../../server/test/e2e/harness.ts";
import { fauxAssistantMessage, fauxText } from "../../server/test/e2e/harness.ts";
import { createSessionViaApi, expect, login, test } from "./fixtures.ts";

test.use({ withAgent: true });

const MEMBER = { username: "mallory", password: "member-password-1" };

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

/** Calls the API as a given session cookie; `crhs.api` always acts as ADMIN. */
async function apiAs(
	crhs: InProcessCrhs,
	cookie: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
	const headers: Record<string, string> = { cookie };
	if (init.body !== undefined) headers["content-type"] = "application/json";
	const response = await fetch(`${crhs.url}${path}`, {
		method: init.method ?? (init.body === undefined ? "GET" : "POST"),
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const text = await response.text();
	return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

test("a session shared for chat lets a member drive it; view only lets them look", async ({
	adminPage: page,
	browser,
	crhs,
}) => {
	const user = await crhs.api("/api/users", {
		body: { username: MEMBER.username, password: MEMBER.password, kind: "member", displayName: "Mallory M" },
	});
	expect(user.status).toBe(201);
	const userId = user.json.user.id as string;
	const sessionId = await createSessionViaApi(crhs, {
		title: "Shared chat",
		message: "start",
		rulePreset: "yolo",
	});

	await page.goto(`/sessions/${sessionId}`);
	await page.getByTestId("share-session").click();
	const shares = page.getByTestId("share-dialog");
	await expect(shares).toContainText("Not shared.");
	await shares.getByLabel("Grantee").click();
	await page.getByRole("option", { name: "Mallory M" }).click();
	await shares.getByLabel("Access").click();
	await page.getByRole("option", { name: "Chat", exact: true }).click();
	await shares.getByRole("button", { name: "Add share" }).click();
	await expect(shares.getByTestId("share-list")).toContainText("mallory");
	await expect(shares.getByTestId("share-list")).toContainText("Chat");
	await page.keyboard.press("Escape");

	const ctx = await browser.newContext({ baseURL: crhs.url });
	try {
		const mp = await ctx.newPage();
		await login(mp, MEMBER);
		await expect(mp.getByTestId("page-title")).toHaveText("Sessions");
		// The list is the owner-and-shared union: the shared session is there without a scope tab.
		const row = mp.locator('[data-testid="session-item"]', { hasText: "Shared chat" });
		await expect(row).toBeVisible({ timeout: 15_000 });
		await row.click();
		// Not the owner: a read-only title and the model as plain text, no share management.
		await expect(mp.getByTestId("session-title")).toHaveCount(0);
		await expect(mp.locator("[data-testid='session-header'] h1")).toContainText("Shared chat");
		await expect(mp.getByTestId("share-session")).toHaveCount(0);

		crhs.faux.setResponses([fauxAssistantMessage([fauxText("Answered for the owner's nodes.")])]);
		await mp.getByTestId("composer-input").fill("Say hello for me");
		await mp.getByTestId("composer-input").press("Enter");
		await expect(mp.getByTestId("transcript-scroller")).toContainText("Answered for the owner's nodes.", {
			timeout: 20_000,
		});

		// The owner turns the share into view only.
		const list = await crhs.api(`/api/sessions/${sessionId}/shares`);
		const shareId = (list.json.shares as { id: string; granteeId: string }[]).find(
			(entry) => entry.granteeId === userId,
		)?.id;
		expect(shareId).toBeTruthy();
		expect(
			(
				await crhs.api(`/api/sessions/${sessionId}/shares`, {
					method: "PUT",
					body: { granteeType: "user", granteeId: userId, access: "view" },
				})
			).status,
		).toBe(200);
		await mp.reload();
		await expect(mp.locator('[data-slot="composer-readonly"]')).toContainText("You have view access");
		await expect(mp.getByTestId("composer-input")).toHaveCount(0);
	} finally {
		await ctx.close();
	}
});

test("only the owner creates shares; administrators list and revoke them", async ({ crhs }) => {
	const member = await crhs.api("/api/users", {
		body: { username: MEMBER.username, password: MEMBER.password, kind: "member" },
	});
	expect(member.status).toBe(201);
	const memberId = member.json.user.id as string;
	const memberCookie = await loginCookie(crhs, MEMBER.username, MEMBER.password);
	const sessionId = await createSessionViaApi(crhs, {
		title: "Mine",
		message: "hello",
		rulePreset: "yolo",
		cookie: memberCookie,
	});
	const adminId = (await crhs.api("/api/me")).json.user.id as string;

	// Nobody can share a session with themselves.
	const self = await apiAs(crhs, memberCookie, `/api/sessions/${sessionId}/shares`, {
		method: "PUT",
		body: { granteeType: "user", granteeId: memberId, access: "view" },
	});
	expect(self.status).toBe(400);

	// The owner may share; here with the administrator so they can list and revoke it.
	const shared = await apiAs(crhs, memberCookie, `/api/sessions/${sessionId}/shares`, {
		method: "PUT",
		body: { granteeType: "user", granteeId: adminId, access: "view" },
	});
	expect(shared.status).toBe(200);

	const shares = await crhs.api(`/api/sessions/${sessionId}/shares`);
	expect(shares.status).toBe(200);
	expect(shares.json.shares).toHaveLength(1);

	// An administrator sees the session and its shares but cannot create another one.
	const denied = await crhs.api(`/api/sessions/${sessionId}/shares`, {
		method: "PUT",
		body: { granteeType: "user", granteeId: "nobody", access: "view" },
	});
	expect(denied.status).toBe(403);
	expect(denied.json.error).toBe("only the owner can share this session");

	// Revoking an existing share is allowed for the administrator.
	const revoked = await crhs.api(`/api/sessions/${sessionId}/shares/${shares.json.shares[0].id}`, {
		method: "DELETE",
		// A state-changing request must be JSON (CSRF guard), even without fields.
		body: {},
	});
	expect(revoked.status).toBe(200);
	expect((await crhs.api(`/api/sessions/${sessionId}/shares`)).json.shares).toEqual([]);
});

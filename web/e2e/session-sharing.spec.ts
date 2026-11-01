import { fauxAssistantMessage, fauxText } from "../../server/test/e2e/harness.ts";
import { expect, login, test } from "./fixtures.ts";

test.use({ withAgent: true });

const MEMBER = { username: "mallory", password: "member-password-1" };

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
	const created = await crhs.api("/api/sessions", {
		body: {
			title: "Shared chat",
			preset: "yolo",
			model: { provider: crhs.faux.provider.id, modelId: crhs.faux.getModel().id },
		},
	});
	expect(created.status).toBe(201);
	const sessionId = created.json.session.id as string;

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

test("only the owner and administrators manage shares", async ({ crhs }) => {
	const created = await crhs.api("/api/sessions", {
		body: {
			title: "Mine",
			preset: "ask",
			model: { provider: crhs.faux.provider.id, modelId: crhs.faux.getModel().id },
		},
	});
	const sessionId = created.json.session.id as string;
	const res = await crhs.api(`/api/sessions/${sessionId}/shares`, {
		method: "PUT",
		body: { granteeType: "user", granteeId: "nobody", access: "view" },
	});
	expect(res.status).toBe(404);
	const shares = await crhs.api(`/api/sessions/${sessionId}/shares`);
	expect(shares.status).toBe(200);
	expect(shares.json.shares).toEqual([]);
});

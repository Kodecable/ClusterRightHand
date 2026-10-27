import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { expect, login, test } from "./fixtures.ts";

test.use({ withAgent: true });

const MEMBER = { username: "mallory", password: "member-password-1" };

/** A session of the administrator's, shared with a member: view or chat (doc/access-control.md#归属与分享). */
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

	await page.goto(`/#/sessions/${sessionId}`);
	const shares = page.getByRole("region", { name: "Shares" });
	await expect(shares).toContainText("Not shared.");
	await shares.getByLabel("Grantee").selectOption({ label: "Mallory M" });
	await shares.getByLabel("Access").selectOption("chat");
	await shares.getByRole("button", { name: "Add share" }).click();
	await expect(shares.getByRole("row").filter({ hasText: "chat" })).toBeVisible();

	const ctx = await browser.newContext({ baseURL: crhs.url });
	try {
		const mp = await ctx.newPage();
		await login(mp, MEMBER);
		await mp.getByRole("link", { name: "Sessions" }).click();
		const row = mp.getByRole("row").filter({ hasText: "Shared chat" });
		await expect(row).toContainText("shared (chat)");
		await expect(row).toContainText("root");
		await row.getByRole("link", { name: "Shared chat" }).click();
		await expect(mp.getByText("Shared by root (chat access).")).toBeVisible();
		// Not the owner: no title/model/preset editing, and no share management.
		await expect(mp.getByRole("button", { name: "Save title" })).toHaveCount(0);
		await expect(mp.getByRole("region", { name: "Shares" })).toHaveCount(0);

		crhs.faux.setResponses([fauxAssistantMessage([fauxText("Answered for the owner's nodes.")])]);
		await mp.getByLabel("Message").fill("Say hello for me");
		await mp.getByLabel("Message").press("Enter");
		await expect(mp.getByRole("log", { name: "Conversation" })).toContainText("Answered for the owner's nodes.");

		// The owner turns the share into view only.
		const list = await crhs.api(`/api/sessions/${sessionId}/shares`);
		const shareId = (list.json.shares as { id: string; granteeId: string }[]).find((s) => s.granteeId === userId)?.id;
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
		await expect(mp.getByText("Shared by root (view access).")).toBeVisible();
		await expect(mp.getByLabel("Message")).toHaveCount(0);
		await expect(mp.getByText("You have view access")).toBeVisible();
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

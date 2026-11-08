import { ADMIN, expect, test } from "./fixtures.ts";

// capjs-core's production defaults are 50 challenges at difficulty 4; two easy ones keep the browser test quick.
test.use({
	captcha: "cap",
	captchaChallenge: { challengeCount: 2, challengeSize: 8, challengeDifficulty: 1 },
});

test("logs in with the invisible proof-of-work captcha", async ({ page }) => {
	// The widget and its WASM are self-hosted: nothing may be fetched from another origin (a CDN).
	const foreign: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
			foreign.push(request.url());
	});
	await page.goto("/");
	await expect(page.getByLabel("Username")).toBeVisible();
	await page.getByLabel("Username").fill(ADMIN.username);
	await page.getByLabel("Password").fill(ADMIN.password);

	// The challenge is requested only after submit, and it must succeed before the credentials are sent.
	const challenge = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" && new URL(response.url()).pathname === "/api/auth/login/challenge",
	);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	expect((await challenge).status()).toBe(200);

	await expect(page).toHaveURL(/\/sessions$/);
	await expect(page.getByTestId("page-title")).toHaveText("Sessions");
	// The invisible widget is removed once the solve is done.
	await expect(page.locator("cap-widget")).toHaveCount(0);
	expect(foreign).toEqual([]);
});

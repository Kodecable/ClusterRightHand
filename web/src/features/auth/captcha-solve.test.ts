import { afterEach, describe, expect, test, vi } from "vitest";
import { loginTag, solveLoginCaptcha } from "./captcha";

const removed = vi.hoisted(() => vi.fn());

/**
 * A stand-in for cap-widget that drives the same two CAP_CUSTOM_FETCH calls the real widget makes.
 * The real widget is never imported in jsdom (its workers and WASM would not run there).
 */
vi.mock("cap-widget", () => {
	class FakeCap {
		readonly widget = { remove: removed };
		token: string | null = null;

		async solve(): Promise<{ success: true; token: string }> {
			const fetchHook = window.CAP_CUSTOM_FETCH;
			if (!fetchHook) throw new Error("CAP_CUSTOM_FETCH was not installed");
			const challengeResponse = await fetchHook("/api/auth/login/challenge", { method: "POST" });
			const challenge = (await challengeResponse.json()) as { token: string };
			const redeemResponse = await fetchHook("/api/auth/login/redeem", {
				method: "POST",
				body: JSON.stringify({ token: challenge.token, solutions: [11, 22] }),
				headers: { "Content-Type": "application/json" },
			});
			const redeem = (await redeemResponse.json()) as { token: string };
			this.token = redeem.token;
			return { success: true, token: redeem.token };
		}
	}
	return { default: FakeCap };
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete window.CAP_CUSTOM_FETCH;
});

describe("solveLoginCaptcha", () => {
	test("requests the challenge with the tag, captures redeem and cleans up", async () => {
		const expires = Date.now() + 120_000;
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ challenge: { c: 2, s: 8, d: 1 }, token: "challenge-token", expires }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(solveLoginCaptcha("root", "secret")).resolves.toEqual({
			token: "challenge-token",
			solutions: [11, 22],
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/auth/login/challenge",
			expect.objectContaining({
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "root", tag: loginTag("root", "secret") }),
			}),
		);
		expect(removed).toHaveBeenCalledTimes(1);
		expect(window.CAP_CUSTOM_FETCH).toBeUndefined();
		expect(window.CAP_CUSTOM_WASM_URL).toBeTruthy();
		expect(window.CAP_CUSTOM_HASHWX_URL).toBeTruthy();
		expect(window.CAP_DISABLE_WIDGET_REF).toBe(true);
	});
});

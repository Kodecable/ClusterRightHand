import { i18n } from "@lingui/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { messages as enMessages } from "@/locales/en.po";
import { messages as zhMessages } from "@/locales/zh-CN.po";
import { loginErrorKind, loginErrorMessage, loginWithCaptcha } from "./api";
import { authStore } from "./session";

const solveLoginCaptcha = vi.hoisted(() =>
	vi.fn<(username: string, password: string) => Promise<{ token: string; solutions: number[] }>>(),
);

vi.mock("./captcha", () => ({ solveLoginCaptcha }));

const USER = {
	id: "u1",
	username: "root",
	displayName: "root",
	email: null,
	kind: "admin",
	status: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
};

interface MockCall {
	path: string;
	body: Record<string, unknown> | undefined;
}

interface MockResponse {
	status: number;
	body: unknown;
}

/** Replace the global fetch with a scripted sequence and record every request's parsed JSON body. */
function mockFetch(responses: MockResponse[]): MockCall[] {
	const calls: MockCall[] = [];
	let index = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				path: new URL(String(input), "http://localhost").pathname,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			});
			const response = responses[Math.min(index, responses.length - 1)];
			index += 1;
			if (!response) throw new Error("mockFetch has no response");
			return new Response(JSON.stringify(response.body), {
				status: response.status,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

beforeEach(() => {
	solveLoginCaptcha.mockReset();
	authStore.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
	authStore.clear();
});

describe("loginWithCaptcha", () => {
	test("with captcha cap: solves first and sends the cap field", async () => {
		solveLoginCaptcha.mockResolvedValue({ token: "challenge-token", solutions: [7, 8, 9] });
		const calls = mockFetch([{ status: 200, body: { user: USER } }]);

		await expect(loginWithCaptcha({ username: "root", password: "secret", captcha: "cap" })).resolves.toMatchObject({
			username: "root",
		});

		expect(solveLoginCaptcha).toHaveBeenCalledExactlyOnceWith("root", "secret");
		expect(calls).toEqual([
			{
				path: "/api/auth/login",
				body: { username: "root", password: "secret", cap: { token: "challenge-token", solutions: [7, 8, 9] } },
			},
		]);
	});

	test("with captcha none: never solves and sends no cap field", async () => {
		const calls = mockFetch([{ status: 200, body: { user: USER } }]);

		await loginWithCaptcha({ username: "root", password: "secret", captcha: "none" });

		expect(solveLoginCaptcha).not.toHaveBeenCalled();
		expect(calls).toEqual([{ path: "/api/auth/login", body: { username: "root", password: "secret" } }]);
	});

	test("solves and retries when the page assumed none but the server requires the captcha", async () => {
		solveLoginCaptcha.mockResolvedValueOnce({ token: "late-token", solutions: [3] });
		const calls = mockFetch([
			{ status: 400, body: { error: "captcha is required", code: "captcha_required" } },
			{ status: 200, body: { user: USER } },
		]);

		await loginWithCaptcha({ username: "root", password: "secret", captcha: "none" });

		expect(solveLoginCaptcha).toHaveBeenCalledTimes(1);
		expect(calls.map((call) => call.body?.cap)).toEqual([undefined, { token: "late-token", solutions: [3] }]);
	});

	test("retries exactly once with a fresh solve after captcha_failed", async () => {
		solveLoginCaptcha
			.mockResolvedValueOnce({ token: "first-token", solutions: [1] })
			.mockResolvedValueOnce({ token: "second-token", solutions: [2] });
		const calls = mockFetch([
			{ status: 403, body: { error: "captcha check failed", code: "captcha_failed", reason: "expired" } },
			{ status: 200, body: { user: USER } },
		]);

		await loginWithCaptcha({ username: "root", password: "secret", captcha: "cap" });

		expect(solveLoginCaptcha).toHaveBeenCalledTimes(2);
		expect(calls.map((call) => call.body?.cap)).toEqual([
			{ token: "first-token", solutions: [1] },
			{ token: "second-token", solutions: [2] },
		]);
	});

	test("does not retry a third time when the second solve is also rejected", async () => {
		solveLoginCaptcha.mockResolvedValue({ token: "token", solutions: [1] });
		const calls = mockFetch([
			{ status: 403, body: { error: "captcha check failed", code: "captcha_failed", reason: "expired" } },
			{ status: 403, body: { error: "captcha check failed", code: "captcha_failed", reason: "scope_mismatch" } },
		]);

		await expect(loginWithCaptcha({ username: "root", password: "secret", captcha: "cap" })).rejects.toMatchObject({
			status: 403,
			code: "captcha_failed",
		});
		expect(solveLoginCaptcha).toHaveBeenCalledTimes(2);
		expect(calls).toHaveLength(2);
	});

	test("does not solve again for an ordinary login failure", async () => {
		solveLoginCaptcha.mockResolvedValue({ token: "token", solutions: [1] });
		const calls = mockFetch([{ status: 401, body: { error: "invalid username or password" } }]);

		await expect(loginWithCaptcha({ username: "root", password: "wrong", captcha: "cap" })).rejects.toMatchObject({
			status: 401,
		});
		expect(solveLoginCaptcha).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(1);
	});
});

describe("login error messages", () => {
	test("maps the server's status/code pairs to kinds", () => {
		expect(loginErrorKind(new ApiError(401, "invalid username or password"))).toBe("invalid_credentials");
		expect(loginErrorKind(new ApiError(429, "too many", "rate_limited"))).toBe("rate_limited");
		expect(loginErrorKind(new ApiError(429, "in progress", "login_in_progress"))).toBe("login_in_progress");
		expect(loginErrorKind(new ApiError(503, "busy", "hash_busy"))).toBe("hash_busy");
		expect(loginErrorKind(new ApiError(403, "failed", "captcha_failed"))).toBe("captcha_failed");
		expect(loginErrorKind(new ApiError(400, "required", "captcha_required"))).toBe("captcha_failed");
		expect(loginErrorKind(new TypeError("Failed to fetch"))).toBe("network");
		expect(loginErrorKind(new ApiError(500, "boom"))).toBeNull();
		expect(loginErrorKind("not an error")).toBeNull();
	});

	test("returns the translated line for every kind", () => {
		i18n.loadAndActivate({ locale: "en", messages: enMessages });
		expect(loginErrorMessage(new ApiError(401, "x"))).toBe("Invalid username or password.");
		expect(loginErrorMessage(new ApiError(429, "x", "rate_limited"))).toBe(
			"Too many failed attempts. Try again later.",
		);
		expect(loginErrorMessage(new ApiError(429, "x", "login_in_progress"))).toBe(
			"Another sign-in from this address is already in progress. Try again.",
		);
		expect(loginErrorMessage(new ApiError(503, "x", "hash_busy"))).toBe("The server is busy. Try again later.");
		expect(loginErrorMessage(new ApiError(403, "x", "captcha_failed"))).toBe(
			"Security verification failed. Try again.",
		);
		expect(loginErrorMessage(new TypeError("Failed to fetch"))).toBe(
			"Sign-in could not be completed. Check your connection and try again.",
		);
		expect(loginErrorMessage(new ApiError(500, "boom"))).toBeNull();

		i18n.loadAndActivate({ locale: "zh-CN", messages: zhMessages });
		expect(loginErrorMessage(new ApiError(503, "x", "hash_busy"))).toBe("服务器繁忙，请稍后重试");
		expect(loginErrorMessage(new ApiError(403, "x", "captcha_failed"))).toBe("安全验证失败，请重试。");
	});
});

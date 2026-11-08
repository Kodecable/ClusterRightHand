import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { type UseMutationResult, useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, http } from "@/lib/api/client";
import type { User } from "@/lib/api/types";
import type { LoginCaptcha } from "./captcha";
import { authStore } from "./session";

export type LoginCaptchaMode = "cap" | "none";

export interface LoginInput {
	username: string;
	password: string;
	/** `GET /auth/login-options`: whether the server requires the proof of work. */
	captcha: LoginCaptchaMode;
}

export const loginOptionsKey = ["auth", "login-options"] as const;

/** The mode is fetched once per login page; it is public and does not change while the page is open. */
export function useLoginOptions() {
	return useQuery({
		queryKey: loginOptionsKey,
		queryFn: ({ signal }) => http.get<{ captcha: LoginCaptchaMode }>("/auth/login-options", { signal }),
		staleTime: Number.POSITIVE_INFINITY,
	});
}

async function signIn(input: LoginInput): Promise<User> {
	if (input.captcha === "none") return authStore.login(input.username, input.password);
	// Imported here so cap-widget (and @noble/hashes) stay out of the shell's main chunk.
	const { solveLoginCaptcha } = await import("./captcha");
	const cap: LoginCaptcha = await solveLoginCaptcha(input.username, input.password);
	return authStore.login(input.username, input.password, cap);
}

function isCaptchaFailure(error: unknown): boolean {
	return error instanceof ApiError && error.status === 403 && error.code === "captcha_failed";
}

/**
 * Sign in, solving a login challenge first when the server asks for one. A challenge rejected on
 * arrival (expired, or bound to an address that changed) gets one fresh solve; anything else is
 * reported to the form unchanged.
 */
export async function loginWithCaptcha(input: LoginInput): Promise<User> {
	try {
		return await signIn(input);
	} catch (error) {
		// The page assumed "none" (login-options failed to load or is stale) but the server wants a proof of work.
		if (input.captcha === "none" && error instanceof ApiError && error.code === "captcha_required") {
			return signIn({ ...input, captcha: "cap" });
		}
		if (!isCaptchaFailure(error)) throw error;
		return signIn(input);
	}
}

export function useLogin(): UseMutationResult<User, Error, LoginInput> {
	// The login form shows the failure beside the fields; a toast would repeat it.
	return useMutation({ mutationFn: loginWithCaptcha, meta: { toast: false } });
}

export type LoginErrorKind =
	| "invalid_credentials"
	| "rate_limited"
	| "login_in_progress"
	| "hash_busy"
	| "captcha_failed"
	| "network";

/** The failure kind the login form shows as a translated line; null means "show the server's message". */
export function loginErrorKind(error: unknown): LoginErrorKind | null {
	if (!(error instanceof Error)) return null;
	if (!(error instanceof ApiError)) return "network";
	switch (error.status) {
		case 401:
			return "invalid_credentials";
		case 403:
			return error.code === "captcha_failed" ? "captcha_failed" : null;
		case 429:
			return error.code === "login_in_progress" ? "login_in_progress" : "rate_limited";
		case 503:
			return error.code === "hash_busy" ? "hash_busy" : null;
		default:
			return error.code === "captcha_required" ? "captcha_failed" : null;
	}
}

const LOGIN_ERROR_MESSAGES = {
	invalid_credentials: msg`Invalid username or password.`,
	rate_limited: msg`Too many failed attempts. Try again later.`,
	login_in_progress: msg`Another sign-in from this address is already in progress. Try again.`,
	hash_busy: msg`The server is busy. Try again later.`,
	captcha_failed: msg`Security verification failed. Try again.`,
	network: msg`Sign-in could not be completed. Check your connection and try again.`,
} as const;

/** The translated line for a known login failure, or null to let `ErrorText` show the thrown message. */
export function loginErrorMessage(error: unknown): string | null {
	const kind = loginErrorKind(error);
	return kind === null ? null : i18n._(LOGIN_ERROR_MESSAGES[kind]);
}

export function useLogout(): UseMutationResult<void, Error, void> {
	return useMutation({ mutationFn: () => authStore.logout() });
}

export interface ChangePasswordInput {
	currentPassword: string;
	newPassword: string;
	/** End every API token of the user as well (the server defaults to false). */
	revokeApiTokens?: boolean;
}

export function useChangePassword(): UseMutationResult<void, Error, ChangePasswordInput> {
	// The dialog shows the failure on its own error line.
	return useMutation({
		mutationFn: (input) => http.post<{ ok: true }>("/auth/password", input).then(() => undefined),
		meta: { toast: false },
	});
}

/** The route director uses this to send `user.kind` checks through one place. */
export function isAdmin(user: User | null): boolean {
	return user?.kind === "admin";
}

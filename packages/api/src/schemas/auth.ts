/**
 * Runtime schemas for the login and password flows (`../users.ts`,
 * doc/design/webui.md "Login captcha", doc/design/access-control.md).
 */
import { z } from "zod";
import { ErrorResponseSchema } from "./common.ts";
import { UserSchema } from "./users.ts";

/** `GET /api/auth/login-options`: whether this crhs asks for a proof of work. */
export const LoginOptionsResponseSchema = z.object({ captcha: z.enum(["cap", "none"]) });

/** `POST /api/auth/login/challenge`: the tag is the browser's salted password digest. */
export const LoginChallengeBodySchema = z.object({
	username: z.string(),
	tag: z.string().describe("base64url_nopad(SHA-256(UTF-8(username) || 0x00 || UTF-8(password)))."),
});

/** The proof-of-work challenge capjs-core issues. */
export const LoginChallengeResponseSchema = z
	.object({
		challenge: z.object({ c: z.number(), s: z.number(), d: z.number() }),
		token: z.string(),
		expires: z.number().describe("Unix milliseconds when the challenge expires."),
	})
	.meta({ id: "LoginChallengeResponse" });

/** `POST /api/auth/login`; `cap` is the proof-of-work submission, ignored when captcha is off. */
export const LoginBodySchema = z.object({
	username: z.string(),
	password: z.string(),
	cap: z.unknown().optional(),
});

export const LoginResponseSchema = z.object({ user: UserSchema });

/** The answer to a login that fails for any account or password reason. */
export const LoginRejectedResponseSchema = ErrorResponseSchema.meta({ id: "LoginRejectedResponse" });

/** A captcha submission that did not verify; `reason` names the capjs-core failure. */
export const CaptchaFailedResponseSchema = ErrorResponseSchema.extend({
	code: z.literal("captcha_failed"),
	reason: z.string(),
}).meta({ id: "CaptchaFailedResponse" });

/** A rate-limited auth request: `rate_limited`, `login_in_progress` or `password_change_in_progress`. */
export const AuthRateLimitedResponseSchema = ErrorResponseSchema.extend({
	code: z.enum(["rate_limited", "login_in_progress", "password_change_in_progress"]),
}).meta({ id: "AuthRateLimitedResponse" });

/** The hash gate is full: the server cannot verify a password right now. */
export const HashBusyResponseSchema = ErrorResponseSchema.extend({ code: z.literal("hash_busy") }).meta({
	id: "HashBusyResponse",
});

/** `POST /api/auth/password`: the caller's own password change. */
export const PasswordChangeBodySchema = z.object({
	currentPassword: z.string(),
	newPassword: z.string().describe("At least 8 characters."),
	revokeApiTokens: z.boolean().optional().describe("Also revoke the caller's API tokens; false by default."),
});

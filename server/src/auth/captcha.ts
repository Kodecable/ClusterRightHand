import { createHash, createHmac, randomBytes } from "node:crypto";
import { type ChallengeSpec, generateChallenge, validateChallenge } from "capjs-core";

/**
 * Stateless proof of work for password login, bound to address + username + password without
 * storing challenges (doc/design/access-control.md).
 *
 * capjs-core makes a signed JWT out of the challenge parameters and verifies the solutions against
 * it, so the server keeps no state. Its secret is generated once per process: challenges live two
 * minutes, and a restart simply invalidates the outstanding ones.
 */

export const CAPTCHA_TTL_MS = 120_000;

export interface CaptchaChallengeParameters {
	challengeCount: number;
	challengeSize: number;
	challengeDifficulty: number;
}

/** capjs-core's defaults: 50 challenges × 32-byte salt, difficulty 4 (≈65k SHA-256 tries per challenge). */
export const DEFAULT_CAPTCHA_CHALLENGE: CaptchaChallengeParameters = {
	challengeCount: 50,
	challengeSize: 32,
	challengeDifficulty: 4,
};

const secret = randomBytes(64);
// Two independent keys from one process secret: one for capjs-core's HMAC, one for the scope HMAC.
const capSecret = secret.subarray(0, 32);
const scopeKey = secret.subarray(32, 64);

/** `base64url_nopad(SHA-256(UTF-8(username) || 0x00 || UTF-8(password)))`, on the exact strings. */
export function loginTag(username: string, password: string): string {
	return createHash("sha256")
		.update(username, "utf8")
		.update(Buffer.from([0]))
		.update(password, "utf8")
		.digest("base64url");
}

/**
 * `base64url(HMAC-SHA256(scopeKey, address || 0x00 || username || 0x00 || tag))`. No trimming or
 * normalisation: the web must use the same submitted strings for the tag and the scope.
 */
export function loginScope(address: string | undefined, username: string, tag: string): string {
	return createHmac("sha256", scopeKey)
		.update(address ?? "", "utf8")
		.update("\0")
		.update(username, "utf8")
		.update("\0")
		.update(tag, "utf8")
		.digest("base64url");
}

export interface LoginChallenge {
	challenge: ChallengeSpec;
	token: string;
	expires: number;
}

/**
 * Issues one challenge for `POST /api/auth/login/challenge`. `ttlMs` and `parameters` exist for the
 * tests (expiry and a low difficulty); the route always uses the defaults.
 */
export async function issueLoginChallenge(input: {
	address: string | undefined;
	username: string;
	tag: string;
	ttlMs?: number;
	parameters?: CaptchaChallengeParameters;
}): Promise<LoginChallenge> {
	const result = await generateChallenge(capSecret, {
		scope: loginScope(input.address, input.username, input.tag),
		expiresMs: input.ttlMs ?? CAPTCHA_TTL_MS,
		...(input.parameters ?? DEFAULT_CAPTCHA_CHALLENGE),
	});
	if (!("challenge" in result)) throw new Error("capjs-core returned an unexpected challenge format");
	return { challenge: result.challenge, token: result.token, expires: result.expires };
}

export type CaptchaValidation = { success: true } | { success: false; reason: string };

/** Recomputes the tag and scope from the submitted credentials and checks the solutions. */
export async function verifyLoginChallenge(input: {
	address: string | undefined;
	username: string;
	password: string;
	token: unknown;
	solutions: unknown;
}): Promise<CaptchaValidation> {
	const tag = loginTag(input.username, input.password);
	const result = await validateChallenge(
		capSecret,
		{
			token: typeof input.token === "string" ? input.token : "",
			solutions: Array.isArray(input.solutions) ? (input.solutions as number[]) : [],
		},
		{ scope: loginScope(input.address, input.username, tag) },
	);
	return result.success ? { success: true } : { success: false, reason: result.reason };
}

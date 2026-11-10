import { type Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { userActor } from "../audit/audit.ts";
import { revokeAllApiTokens } from "../auth/api-tokens.ts";
import { type CaptchaChallengeParameters, issueLoginChallenge, verifyLoginChallenge } from "../auth/captcha.ts";
import { HashBusyError } from "../auth/hash-gate.ts";
import { LoginLimiter, loginAttemptKeys, passwordAttemptKeys } from "../auth/login-limiter.ts";
import { hashPassword, needsRehash, verifyPassword } from "../auth/password.ts";
import { createWebSession, revokeUserWebSessions, revokeWebSession, SESSION_COOKIE } from "../auth/sessions.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { Db } from "../storage/db.ts";
import { findUserByUsername, setPassword, storePasswordHash, toPublicUser } from "../users/service.ts";
import { UserError } from "../util/errors.ts";
import { rejectRevokedTokenWaits } from "./api-token-waits.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireUser } from "./middleware.ts";

/** Verified against when the username does not exist, so both cases take the same time. */
const dummyHash = hashPassword("crh-dummy-password");
/** A failed attempt's audit record keeps at most this much of the request's username. */
const MAX_AUDITED_USERNAME = 256;
/** `base64url_nopad(SHA-256(...))` is 43 characters. */
const CAPTCHA_TAG_RE = /^[A-Za-z0-9_-]{43}$/;

export interface AuthRoutesOptions {
	limiter?: LoginLimiter;
	/** The client address used for rate limiting and the captcha scope; tests run without a socket. */
	clientAddress?: (c: Context) => string | undefined;
	/** With taskGroups, rejects the waiting work of tokens a password change revokes; tests may omit them. */
	cluster?: Cluster;
	taskGroups?: TaskGroups;
	/** `[auth] captcha`; "cap" by default, tests pass "none". */
	captcha?: "cap" | "none";
	/** Lowers the proof-of-work cost for the "cap" tests; production keeps capjs-core's defaults. */
	captchaChallenge?: CaptchaChallengeParameters;
	/**
	 * Ends the user's open SSE streams whose WebUI session no longer exists (logout, password change). The
	 * app wires it to SessionStreams and the session-list hub; the 15 s ping check is the fallback.
	 */
	revalidateWebSessions?: (userId: string) => Promise<void> | void;
}

export function authRoutes(db: Db, options: AuthRoutesOptions = {}) {
	const limiter = options.limiter ?? new LoginLimiter();
	const captcha = options.captcha ?? "cap";
	const app = new Hono<AppEnv>();

	app.get("/login-options", (c) => c.json({ captcha }));

	app.post("/login/challenge", async (c) => {
		if (captcha === "none") return jsonError(c, 404, "captcha is disabled");
		const body = await readJsonObject(c);
		const username = body?.username;
		const tag = body?.tag;
		if (typeof username !== "string" || typeof tag !== "string") {
			return jsonError(c, 400, "username and tag are required");
		}
		if (!CAPTCHA_TAG_RE.test(tag)) return jsonError(c, 400, "tag must be a 43-character base64url string");
		const address = options.clientAddress?.(c);
		// The login would be rate-limited before it reads the password; do not let the client burn CPU first.
		if (limiter.isBlocked(loginAttemptKeys(address, username).all)) {
			return jsonError(c, 429, "too many failed attempts, try again later", { code: "rate_limited" });
		}
		return c.json(
			await issueLoginChallenge({
				address,
				username,
				tag,
				parameters: options.captchaChallenge,
			}),
		);
	});

	app.post("/login", async (c) => {
		const body = await readJsonObject(c);
		const username = body?.username;
		const password = body?.password;
		if (typeof username !== "string" || typeof password !== "string") {
			return jsonError(c, 400, "username and password are required");
		}
		const address = options.clientAddress?.(c);

		// The PoW is checked before the limiter and before Argon2id: a failure here is not a login attempt.
		if (captcha === "cap") {
			const cap = body?.cap;
			if (cap === undefined || cap === null) {
				return jsonError(c, 400, "captcha is required", { code: "captcha_required" });
			}
			const submission: Record<string, unknown> =
				typeof cap === "object" && !Array.isArray(cap) ? (cap as Record<string, unknown>) : {};
			const result = await verifyLoginChallenge({
				address,
				username,
				password,
				token: submission.token,
				solutions: submission.solutions,
			});
			if (!result.success) {
				return c.json({ error: "captcha check failed", code: "captcha_failed", reason: result.reason }, 403);
			}
		}

		// Without a known client address only the address+username key applies; a shared "unknown" key would let
		// anyone lock every account out.
		const keys = loginAttemptKeys(address, username);
		// Check-and-increment as one synchronous step: a burst of concurrent requests cannot all pass it. This
		// attempt is counted as a failure up front; a success gives its own reservation back below.
		// The in-flight check comes first so a request turned away here is not counted as a failure.
		if (address !== undefined && !limiter.beginVerify(address)) {
			return jsonError(c, 429, "a login from this address is already in progress", { code: "login_in_progress" });
		}
		if (!limiter.reserve(keys.all)) {
			if (address !== undefined) limiter.endVerify(address);
			return jsonError(c, 429, "too many failed attempts, try again later", { code: "rate_limited" });
		}

		try {
			const user = await findUserByUsername(db, username);
			const failed = (reason: string) =>
				void c.get("audit").record({
					actor: { type: "system", id: "auth", onBehalfOfUserId: user?.id ?? null },
					action: "auth.login_failed",
					target: user ? { type: "user", id: user.id } : undefined,
					detail: { username: username.slice(0, MAX_AUDITED_USERNAME), reason, address },
				});
			let ok: boolean;
			try {
				ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash), "login");
			} catch (err) {
				// A full hash queue is the server's state, not a guess: give the reservation back (503 follows).
				if (err instanceof HashBusyError) for (const key of keys.all) limiter.refund(key);
				throw err;
			}
			if (!user?.password_hash || !ok || user.status !== "active") {
				failed(!user ? "unknown_user" : !user.password_hash ? "no_password" : !ok ? "wrong_password" : "disabled");
				return jsonError(c, 401, "invalid username or password");
			}
			// Clear only this address+username pair; the address key keeps its failures for other users. The
			// successful attempt itself was reserved above, so take that one back.
			limiter.clearUser(keys.userKey);
			if (keys.addressKey !== undefined) limiter.refund(keys.addressKey);
			// The password just verified, so the rehash stores it without the policy check a new password gets.
			if (needsRehash(user.password_hash)) await storePasswordHash(db, user.id, password);

			const { token, expiresAt } = await createWebSession(db, user.id, {
				ip: address ?? null,
				userAgent: c.req.header("user-agent"),
			});
			setCookie(c, SESSION_COOKIE, token, {
				path: "/",
				httpOnly: true,
				sameSite: "Strict",
				secure: !isLoopbackHost(c.req.header("host")),
				expires: expiresAt,
			});
			void c.get("audit").record({
				actor: { type: "user", id: user.id, onBehalfOfUserId: user.id },
				action: "auth.login",
				target: { type: "user", id: user.id },
				detail: { username: user.username, address },
			});
			const { password_hash: _, ...publicRow } = user;
			return c.json({ user: toPublicUser(publicRow) });
		} finally {
			if (address !== undefined) limiter.endVerify(address);
		}
	});

	app.use("/logout", requireUser(db));
	app.post("/logout", async (c) => {
		await revokeWebSession(db, c.get("user").sessionId);
		// The SSE loops keep the cookie they authenticated with; end this session's streams now.
		await options.revalidateWebSessions?.(c.get("user").userId);
		deleteCookie(c, SESSION_COOKIE, { path: "/" });
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "auth.logout",
			target: { type: "user", id: c.get("user").userId },
		});
		return c.json({ ok: true });
	});

	app.use("/password", requireUser(db));
	app.post("/password", async (c) => {
		const body = await readJsonObject(c);
		const current = body?.currentPassword;
		const next = body?.newPassword;
		if (typeof current !== "string" || typeof next !== "string") {
			return jsonError(c, 400, "currentPassword and newPassword are required");
		}
		if (body?.revokeApiTokens !== undefined && typeof body.revokeApiTokens !== "boolean") {
			return jsonError(c, 400, "revokeApiTokens must be a boolean");
		}
		const me = c.get("user");
		const address = options.clientAddress?.(c);
		// The same limiter as login, keyed by account and address: guessing the current password is an
		// online guess too, and a wrong one counts exactly like a failed login (doc/design/webui.md "Login captcha").
		const keys = passwordAttemptKeys(address, me.userId);
		const verifyKey = `password-user:${me.userId}`;
		// One in-flight hash per account; two concurrent changes would both verify and race the write.
		if (!limiter.beginVerify(verifyKey)) {
			return jsonError(c, 429, "a password change for this account is already in progress", {
				code: "password_change_in_progress",
			});
		}
		if (!limiter.reserve(keys.all)) {
			limiter.endVerify(verifyKey);
			return jsonError(c, 429, "too many failed attempts, try again later", { code: "rate_limited" });
		}
		try {
			const row = await db.selectFrom("users").select("password_hash").where("id", "=", me.userId).executeTakeFirst();
			let ok: boolean;
			try {
				ok = row?.password_hash ? await verifyPassword(current, row.password_hash) : false;
			} catch (err) {
				// A full gate is the server's state, not a guess: give the reservation back (503 follows).
				if (err instanceof HashBusyError) for (const key of keys.all) limiter.refund(key);
				throw err;
			}
			if (!ok) return jsonError(c, 403, "current password is wrong");
			// The password was right, so this is not a failed attempt; only the other-session revocation
			// below can fail. Clear before the write, like a successful login.
			limiter.clearUser(keys.userKey);
			if (keys.addressKey !== undefined) limiter.refund(keys.addressKey);
			try {
				await setPassword(db, me.userId, next);
			} catch (err) {
				if (err instanceof UserError) return jsonError(c, 400, err.message);
				throw err;
			}
			// Sign out every other session; keep this one.
			await revokeUserWebSessions(db, me.userId, { except: me.sessionId });
			// Every other open stream now holds a session that no longer exists; this one stays open.
			await options.revalidateWebSessions?.(me.userId);
			// Web sessions and API tokens are separate: a password change leaves tokens usable unless asked.
			const revokeApiTokens = body?.revokeApiTokens === true;
			const revokedApiTokens = revokeApiTokens ? await revokeAllApiTokens(db, me.userId) : [];
			await rejectRevokedTokenWaits(db, options.cluster, options.taskGroups, revokedApiTokens, me.userId);
			void c.get("audit").record({
				actor: userActor(me),
				action: "auth.password_changed",
				target: { type: "user", id: me.userId },
				detail: { revoke_api_tokens: revokeApiTokens, revoked_api_tokens: revokedApiTokens.length },
			});
			return c.json({ ok: true });
		} finally {
			limiter.endVerify(verifyKey);
		}
	});

	return app;
}

function isLoopbackHost(host: string | undefined): boolean {
	if (!host) return false;
	const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
	return name === "localhost" || name === "::1" || /^127\.\d+\.\d+\.\d+$/.test(name ?? "");
}

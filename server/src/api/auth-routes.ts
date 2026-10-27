import { type Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { userActor } from "../audit/audit.ts";
import { LoginLimiter } from "../auth/login-limiter.ts";
import { hashPassword, needsRehash, verifyPassword } from "../auth/password.ts";
import { createWebSession, revokeUserWebSessions, revokeWebSession, SESSION_COOKIE } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import { findUserByUsername, setPassword, toPublicUser, UserError } from "../users/service.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { requireUser } from "./middleware.ts";

/** Verified against when the username does not exist, so both cases take the same time. */
const dummyHash = hashPassword("crh-dummy-password");

export interface AuthRoutesOptions {
	limiter?: LoginLimiter;
	/** The client address used for rate limiting; tests run without a socket. */
	clientAddress?: (c: Context) => string | undefined;
}

export function authRoutes(db: Db, options: AuthRoutesOptions = {}) {
	const limiter = options.limiter ?? new LoginLimiter();
	const app = new Hono<AppEnv>();

	app.post("/login", async (c) => {
		const body = await readJsonObject(c);
		const username = body?.username;
		const password = body?.password;
		if (typeof username !== "string" || typeof password !== "string") {
			return jsonError(c, 400, "username and password are required");
		}
		const address = options.clientAddress?.(c);
		// Without a known client address only the per-username limit applies; a shared "unknown" key would let
		// anyone lock every account out.
		const keys = [`user:${username.trim().toLowerCase()}`, ...(address ? [`addr:${address}`] : [])];
		// Rate-limited attempts are not audited: a brute-force run would otherwise fill the audit log.
		if (limiter.isBlocked(keys)) return jsonError(c, 429, "too many failed attempts, try again later");

		const user = await findUserByUsername(db, username);
		const failed = (reason: string) =>
			void c.get("audit").record({
				actor: { type: "system", id: "auth", onBehalfOfUserId: user?.id ?? null },
				action: "auth.login_failed",
				target: user ? { type: "user", id: user.id } : undefined,
				detail: { username, reason, address },
			});
		const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
		if (!user?.password_hash || !ok || user.status !== "active") {
			limiter.recordFailure(keys);
			failed(!user ? "unknown_user" : !user.password_hash ? "no_password" : !ok ? "wrong_password" : "disabled");
			return jsonError(c, 401, "invalid username or password");
		}
		limiter.reset(keys);
		if (needsRehash(user.password_hash)) await setPassword(db, user.id, password);

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
	});

	app.use("/logout", requireUser(db));
	app.post("/logout", async (c) => {
		await revokeWebSession(db, c.get("user").sessionId);
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
		const me = c.get("user");
		const row = await db.selectFrom("users").select("password_hash").where("id", "=", me.userId).executeTakeFirst();
		if (!row?.password_hash || !(await verifyPassword(current, row.password_hash))) {
			return jsonError(c, 403, "current password is wrong");
		}
		try {
			await setPassword(db, me.userId, next);
		} catch (err) {
			if (err instanceof UserError) return jsonError(c, 400, err.message);
			throw err;
		}
		// Sign out every other session; keep this one.
		await revokeUserWebSessions(db, me.userId, { except: me.sessionId });
		void c.get("audit").record({
			actor: userActor(me),
			action: "auth.password_changed",
			target: { type: "user", id: me.userId },
		});
		return c.json({ ok: true });
	});

	return app;
}

function isLoopbackHost(host: string | undefined): boolean {
	if (!host) return false;
	const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
	return name === "localhost" || name === "::1" || /^127\.\d+\.\d+\.\d+$/.test(name ?? "");
}

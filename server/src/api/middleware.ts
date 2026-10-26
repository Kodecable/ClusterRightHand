import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveWebSession, SESSION_COOKIE } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError } from "./context.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests: state-changing requests must be JSON (which a cross-site
 * form cannot send without a CORS preflight) and, when the browser sends Origin, it must match the Host.
 * The session cookie is also SameSite=Strict.
 */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
	if (!SAFE_METHODS.has(c.req.method)) {
		const contentType = c.req.header("content-type") ?? "";
		if (!contentType.toLowerCase().startsWith("application/json")) {
			return jsonError(c, 400, "content-type must be application/json");
		}
		const origin = c.req.header("origin");
		if (origin !== undefined) {
			let originHost: string | undefined;
			try {
				originHost = new URL(origin).host;
			} catch {}
			if (originHost !== c.req.header("host")) return jsonError(c, 403, "cross-origin request rejected");
		}
	}
	await next();
};

export function requireUser(db: Db): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const token = getCookie(c, SESSION_COOKIE);
		const user = token ? await resolveWebSession(db, token) : undefined;
		if (!user) return jsonError(c, 401, "not signed in");
		c.set("user", user);
		await next();
	};
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (c.get("user").kind !== "admin") return jsonError(c, 403, "administrator only");
	await next();
};

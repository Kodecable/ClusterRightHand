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

/** Administrators only: anyone else gets a 403 with `message`. Expects requireUser to have run. */
function adminGate(message: string): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (c.get("user").kind !== "admin") return jsonError(c, 403, message);
		await next();
	};
}

/**
 * Administrators only, for every route under a path (`app.use`): the users, user groups and node access
 * grants routes. Its 403 reads "administrator only", unlike `adminOnly`'s; both texts are kept as they were.
 */
export const requireAdmin = adminGate("administrator only");

/**
 * Administrators only, as the first handler of one route (`app.get(path, adminOnly, handler)`), so a method
 * or path no route has stays unanswered as before. Its 403 reads "administrators only".
 */
export const adminOnly = adminGate("administrators only");

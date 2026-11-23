import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { isAdmin, resolveWebSession, SESSION_COOKIE } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import { normalizedHost } from "../util/host.ts";
import { type AppEnv, jsonError } from "./context.ts";

export { normalizedHost } from "../util/host.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests: state-changing requests must be JSON (which a cross-site
 * form cannot send without a CORS preflight) and, when the browser sends Origin, it must match the Host.
 * The session cookie is also SameSite=Strict. An internal `api_request` carries its identity in the
 * request's bindings and sends no cookie, so it has no cross-site vector and is let through.
 */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
	if (c.env?.crhInternal !== undefined) return next();
	if (!SAFE_METHODS.has(c.req.method)) {
		const contentType = (c.req.header("content-type") ?? "").toLowerCase();
		// A library upload is a raw stream; application/octet-stream is not a CORS-safelisted request
		// content type, so a cross-site form cannot send it and a cross-site fetch needs a preflight.
		const libraryUpload = c.req.method === "PUT" && /^\/api\/libraries\/[^/]+\/file$/.test(c.req.path);
		if (libraryUpload) {
			if (!contentType.startsWith("application/octet-stream")) {
				return jsonError(c, 400, "content-type must be application/octet-stream");
			}
		} else if (!contentType.startsWith("application/json")) {
			return jsonError(c, 400, "content-type must be application/json");
		}
		const origin = c.req.header("origin");
		if (origin !== undefined) {
			let originUrl: URL | undefined;
			try {
				originUrl = new URL(origin);
			} catch {}
			const scheme = originUrl?.protocol.slice(0, -1) ?? "";
			const host = c.req.header("host");
			if (!originUrl || host === undefined || normalizedHost(host, scheme) !== normalizedHost(originUrl.host, scheme)) {
				return jsonError(c, 403, "cross-origin request rejected");
			}
		}
	}
	await next();
};

export function requireUser(db: Db): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		// An in-process api_request identifies the session owner in the request's bindings; a network request
		// cannot set them, so no header can impersonate anyone.
		const internal = c.env?.crhInternal;
		if (internal) {
			const row = await db
				.selectFrom("users")
				.select(["id", "username", "kind", "status"])
				.where("id", "=", internal.userId)
				.executeTakeFirst();
			if (row?.status !== "active") return jsonError(c, 401, "not signed in");
			c.set("user", {
				sessionId: `internal:${internal.actor.id}`,
				userId: row.id,
				username: row.username,
				kind: row.kind,
				actor: internal.actor,
			});
			return next();
		}
		const token = getCookie(c, SESSION_COOKIE);
		const user = token ? await resolveWebSession(db, token) : undefined;
		if (!user) return jsonError(c, 401, "not signed in");
		c.set("user", user);
		await next();
	};
}

/**
 * Administrators only, for every route under a path (`app.use`) or as the first handler of one route
 * (`app.get(path, requireAdmin, handler)`); either way a non-administrator gets a 403 reading
 * "administrators only". Expects requireUser to have run.
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (!isAdmin(c.get("user"))) return jsonError(c, 403, "administrators only");
	await next();
};

/**
 * The `GET /users/:id` case: administrators read anyone, everyone else only the user id in the path. A
 * different id answers the same 404 a missing user gets, so a member cannot probe for accounts. Every other
 * `/users` route stays behind {@link requireAdmin}.
 */
export const requireAdminOrSelf: MiddlewareHandler<AppEnv> = async (c, next) => {
	const id = c.req.param("id");
	if (!isAdmin(c.get("user")) && c.get("user").userId !== id) return jsonError(c, 404, "no such user");
	await next();
};

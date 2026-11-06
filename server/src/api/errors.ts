import type { Context } from "hono";
import { SshError } from "../cluster/ssh/connection.ts";
import { WebauthnError } from "../privilege/webauthn.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { type AppEnv, jsonError } from "./context.ts";

/**
 * The API's one error handler, registered by createApp: what each route group used to map in its own handler,
 * in the same order. NotFoundError is a 404, a rejected request (UserError — a bad authorization or a request
 * body that does not match a route's schema is one — a Passkey failure) a 400, and an SSH failure a 502 with
 * its code. Anything else is a server bug and gets the answer Hono's default handler gives: a bare 500, never
 * the error's message.
 */
export function apiErrorHandler(options: { closing?: () => boolean } = {}) {
	return (err: Error, c: Context<AppEnv>) => {
		// The session routes reach the agent runtime, which shutdown closes under requests already in flight
		// (main.ts): those answer with the shutdown, not with the closed Harness's exception.
		if (options.closing?.()) return jsonError(c, 503, "server is shutting down");
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError) return jsonError(c, 400, err.message);
		if (err instanceof WebauthnError) return jsonError(c, 400, err.message);
		if (err instanceof SshError) return c.json({ error: err.message, code: err.code }, 502);
		console.error(err);
		return c.text("Internal Server Error", 500);
	};
}

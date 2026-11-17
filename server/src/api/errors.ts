import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { HashBusyError } from "../auth/hash-gate.ts";
import { SshError } from "../cluster/ssh/connection.ts";
import { WebauthnError } from "../privilege/webauthn.ts";
import { BadGatewayError, NotFoundError, UserError } from "../util/errors.ts";
import { type AppEnv, jsonError } from "./context.ts";

/**
 * The API's one error handler, registered by createApp: what each route group used to map in its own handler,
 * in the same order. NotFoundError is a 404, a rejected request (UserError — a bad authorization or a request
 * body that does not match a route's schema is one — a Passkey failure) a 400, and an SSH failure a 502 with
 * its code. An upstream failure (BadGatewayError) is a 502 with its message. Anything else is a server bug and
 * gets the answer Hono's default handler gives: a bare 500, never the error's message.
 */
export function apiErrorHandler(options: { closing?: () => boolean } = {}) {
	return (err: Error, c: Context<AppEnv>) => {
		// The session routes reach the agent runtime, which shutdown closes under requests already in flight
		// (main.ts): those answer with the shutdown, not with the closed Harness's exception.
		if (options.closing?.()) return jsonError(c, 503, "server is shutting down");
		if (err instanceof HashBusyError) {
			return jsonError(c, 503, "the server is busy, try again", {
				code: "hash_busy",
				headers: { "Retry-After": "1" },
			});
		}
		// Hono's own rejections, such as a malformed JSON body during schema validation: a prepared response is
		// kept, anything else answers like a rejected request.
		if (err instanceof HTTPException) {
			if (err.res) return err.getResponse();
			return c.json({ error: err.message }, err.status);
		}
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof BadGatewayError) return jsonError(c, 502, err.message);
		if (err instanceof UserError) return jsonError(c, 400, err.message);
		if (err instanceof WebauthnError) return jsonError(c, 400, err.message);
		if (err instanceof SshError) return c.json({ error: err.message, code: err.code }, 502);
		console.error(err);
		return c.text("Internal Server Error", 500);
	};
}

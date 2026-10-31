import type { ServerResponse } from "node:http";
import type { MiddlewareHandler } from "hono";
import { type AppEnv, jsonError } from "./context.ts";

/**
 * Counts the requests being handled (and the replies still being written) and the session event streams still
 * open, so that shutdown can wait for them, and refuses new requests once it has begun (main.ts).
 */
export class RequestDrain {
	#open = 0;
	#draining = false;
	/** Every waitForIdle caller; shutdown and a test may both wait, and each must be resolved. */
	readonly #idle = new Set<() => void>();
	/** Aborted when shutdown begins; open event streams end on it the way they end on a client disconnect. */
	readonly shutdown = new AbortController();

	get draining(): boolean {
		return this.#draining;
	}

	/** Refuses new requests from now on and tells the open event streams to finish. */
	begin(): void {
		if (this.#draining) return;
		this.#draining = true;
		this.shutdown.abort();
	}

	/** Every request goes through here: counted while it is handled, refused once shutdown has begun. */
	middleware(): MiddlewareHandler<AppEnv> {
		return async (c, next) => {
			if (this.#draining) {
				c.header("Connection", "close");
				return jsonError(c, 503, "server is shutting down");
			}
			const release = this.hold();
			// The adapter writes the response after the handler returns, so a second hold covers the reply
			// itself: shutdown drops the connections right after the drain goes idle (main.ts), and a reply
			// still being written would be cut off. The node adapter passes the response as env.outgoing; a
			// test client (app.request) has none and needs no reply hold.
			const outgoing = (c.env as { outgoing?: ServerResponse } | undefined)?.outgoing;
			if (outgoing) {
				const releaseReply = this.hold();
				outgoing.once("finish", releaseReply);
				outgoing.once("close", releaseReply);
				// The client may have gone before this middleware ran, in which case no event will follow.
				if (outgoing.writableFinished || outgoing.destroyed) releaseReply();
			}
			try {
				await next();
			} finally {
				release();
			}
		};
	}

	/**
	 * Counts one unit of in-flight work until the returned function is called: a request, or an event stream
	 * that outlives its response (an SSE callback runs after the response has been returned).
	 */
	hold(): () => void {
		this.#open++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#open--;
			if (this.#open === 0) {
				// Every waiter resolves now: a single resolver would leave a second caller pending forever.
				for (const resolve of this.#idle) resolve();
				this.#idle.clear();
			}
		};
	}

	/** Resolves once `begin()` has been called and every held request and stream has finished. */
	waitForIdle(): Promise<void> {
		if (this.#open === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.#idle.add(resolve);
		});
	}
}

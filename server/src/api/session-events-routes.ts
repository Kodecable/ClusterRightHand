import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { SessionListScope, SessionListSubscriber } from "../agent/session-list.ts";
import { sessionCapabilities } from "../agent/sharing.ts";
import { isAdmin, type SessionUser, webSessionAlive } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import { type AppEnv, jsonError } from "./context.ts";
import type { RequestDrain } from "./drain.ts";
import { SESSION_SCOPES, visibleSession } from "./session-routes.ts";

type LiveStream = { user: SessionUser; sessionId: string; abort: () => void };

/**
 * The open session event streams (`GET /sessions/:id/events`): an access change ends the streams whose viewer
 * lost the session, and shutdown ends them all. Shared with the session routes, whose share removal revalidates.
 */
export class SessionStreams {
	readonly #db: Db;
	readonly #streams = new Set<LiveStream>();

	constructor(db: Db, runtime: AgentRuntime, drain?: RequestDrain) {
		this.#db = db;
		// A user's status/kind, a user group membership or a share change reaches the streams through the session list
		// hub, which the user routes also hold: this is the same path for every access change.
		const unsubscribeVisibility = runtime.sessionList.onVisibilityChanged(() => this.revalidate());
		// Shutdown ends every stream, so no request outlives the database it may still need.
		drain?.shutdown.signal.addEventListener(
			"abort",
			() => {
				unsubscribeVisibility();
				for (const stream of [...this.#streams]) this.#end(stream);
				runtime.sessionList.close();
			},
			{ once: true },
		);
	}

	add(stream: LiveStream): void {
		this.#streams.add(stream);
	}

	delete(stream: LiveStream): void {
		this.#streams.delete(stream);
	}

	/** A share change or an account change can remove access to a session or to a root whose subagents it watches. */
	async revalidate(): Promise<void> {
		for (const stream of [...this.#streams]) {
			const viewer = await this.#currentViewer(stream.user);
			if (viewer && (await sessionCapabilities(this.#db, viewer, stream.sessionId))) continue;
			this.#end(stream);
		}
	}

	/**
	 * Ends the streams of a user whose WebUI session was revoked (logout, password change, an administrator's
	 * reset). The SSE loop re-checks every 15 s anyway; this ends them while the request that revoked the
	 * session is still running, the same way endUserStreams ends the session-list streams.
	 */
	async revalidateWebSessions(userId: string): Promise<void> {
		for (const stream of [...this.#streams]) {
			if (stream.user.userId !== userId) continue;
			if (await webSessionAlive(this.#db, stream.user.sessionId)) continue;
			this.#end(stream);
		}
	}

	/** Ends a stream the way a client disconnect does: its abort controller fires and the loop below runs out. */
	#end(stream: LiveStream): void {
		this.#streams.delete(stream);
		stream.abort();
	}

	/**
	 * The viewer as the account is now. A stream opened before a kind change or a disable would otherwise keep
	 * the capabilities it was opened with.
	 */
	async #currentViewer(user: SessionUser): Promise<SessionUser | undefined> {
		const row = await this.#db
			.selectFrom("users")
			.select(["id", "username", "kind", "status"])
			.where("id", "=", user.userId)
			.executeTakeFirst();
		if (row?.status !== "active") return undefined;
		return { ...user, username: row.username, kind: row.kind };
	}
}

export interface SessionEventRoutesOptions {
	runtime: AgentRuntime;
	streams: SessionStreams;
	/** Shutdown bookkeeping: its abort ends the event streams, and each stream keeps shutdown waiting. */
	drain?: RequestDrain;
}

/** `stream.sleep`, but wakes up when the stream ends, so shutdown need not wait out a ping interval. */
function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * The server-sent event streams of sessions: the session list's changes and one session's events
 * (doc/design/webui.md "Session list API", doc/design/webui.md "Session event stream and history"). Expects requireUser. Registered before the session
 * routes, so that `/sessions/stream` is not taken for a session id.
 */
export function sessionEventRoutes(db: Db, options: SessionEventRoutesOptions) {
	const { runtime, streams, drain } = options;
	const app = new Hono<AppEnv>();

	/**
	 * Session list changes as server-sent events (doc/design/webui.md "Session list API"): `upsert` carries the item as this
	 * subscriber sees it, `remove` says the session is gone (deleted, no longer shared, archived), and `ping`
	 * keeps the connection alive. No initial snapshot: the client fetches page one and reconnects after errors.
	 */
	app.get("/sessions/stream", (c) => {
		// The stream takes the list's scopes; omitted keeps the historical audience (every administrator gets
		// every root session). The WebUI asks for `visible` so its stream matches the list it patches.
		const scope = c.req.query("scope");
		if (scope !== undefined && !SESSION_SCOPES.has(scope)) {
			return jsonError(c, 400, "scope must be mine, shared, visible or all");
		}
		if (scope === "all" && !isAdmin(c.get("user"))) return jsonError(c, 403, "administrators only");
		// A HEAD probe checks access without opening a stream: Hono serves HEAD with this GET handler and
		// drops the body, so `streamSSE` here would register and hold a stream nobody reads.
		if (c.req.method === "HEAD") return c.body(null, 200);
		return streamSSE(c, async (stream) => {
			const abort = new AbortController();
			let queue: Promise<unknown> = Promise.resolve();
			const subscriber: SessionListSubscriber = {
				user: c.get("user"),
				scope: scope as SessionListScope | undefined,
				send: (event, data) => {
					queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
					void queue.catch(() => stream.abort());
				},
				close: () => stream.abort(),
			};
			let unsubscribe: (() => void) | undefined;
			stream.onAbort(() => {
				unsubscribe?.();
				abort.abort();
			});
			// As with a session's event stream, the connection keeps shutdown waiting until it ends.
			const release = drain?.hold();
			try {
				unsubscribe = runtime.sessionList.subscribe(subscriber);
				if (drain?.shutdown.signal.aborted) stream.abort();
				if (abort.signal.aborted) return;
				while (!abort.signal.aborted) {
					await sleepFor(15_000, abort.signal);
					if (abort.signal.aborted) break;
					// WebUI sessions can be revoked after the stream authenticated (logout, password change);
					// the connection must not keep reading with the old cookie.
					if (!(await webSessionAlive(db, subscriber.user.sessionId))) {
						stream.abort();
						break;
					}
					await stream.writeSSE({ event: "ping", data: "" });
				}
			} finally {
				unsubscribe?.();
				release?.();
			}
		});
	});

	/** Server-sent events: `snapshot` first, then `events` batches as the session changes. */
	app.get("/sessions/:id/events", async (c) => {
		const v = await visibleSession(db, runtime, c.get("user"), c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		// A HEAD probe checks access without opening a stream: Hono serves HEAD with this GET handler and
		// drops the body, so `streamSSE` here would register and hold a stream nobody reads.
		if (c.req.method === "HEAD") return c.body(null, 200);
		return streamSSE(c, async (stream) => {
			const abort = new AbortController();
			const live: LiveStream = { user: c.get("user"), sessionId: v.session.id, abort: () => stream.abort() };
			stream.onAbort(() => {
				streams.delete(live);
				abort.abort();
			});
			streams.add(live);
			// The stream outlives its response, so it keeps shutdown waiting until this callback returns.
			const release = drain?.hold();
			let stop: (() => void) | undefined;
			try {
				// Shutdown may have begun between authentication and the stream opening: end it now.
				if (drain?.shutdown.signal.aborted) stream.abort();
				if (abort.signal.aborted) return;
				let queue = Promise.resolve();
				stop = await runtime.watch(
					v.session.id,
					(events) => {
						queue = queue.then(() => stream.writeSSE({ event: "events", data: JSON.stringify(events) }));
						return queue;
					},
					abort.signal,
				);
				// Keep the stream (and proxies) alive while the session is quiet.
				while (!abort.signal.aborted) {
					await sleepFor(15_000, abort.signal);
					if (abort.signal.aborted) break;
					// The cookie may have been revoked since this stream opened; end it instead of pinging.
					if (!(await webSessionAlive(db, live.user.sessionId))) {
						stream.abort();
						break;
					}
					await stream.writeSSE({ event: "ping", data: "" });
				}
			} finally {
				// A failed write must still end the watch and forget the stream, not leave both behind.
				streams.delete(live);
				if (stop) await stop();
				release?.();
			}
		});
	});

	return app;
}

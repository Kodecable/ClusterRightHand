import type { SessionState } from "../session-state.ts";

/**
 * The per-session state recomputations in flight (doc/agent-runtime.md#会话状态).
 *
 * Refreshes of one session are serialized and coalesced (D118): a request while one runs marks it dirty and
 * shares its promise, and the running one recomputes once more after it finishes, so the last write is always
 * computed from data read after the latest request. A throwing recompute still removes its entry.
 */
export class StateRefreshes {
	readonly #running = new Map<string, { again: boolean; done: Promise<SessionState> }>();

	/** Recomputes `sessionId` with `compute`, or joins the recompute already running for it. */
	run(sessionId: string, compute: (sessionId: string) => Promise<SessionState>): Promise<SessionState> {
		const running = this.#running.get(sessionId);
		if (running) {
			running.again = true;
			return running.done;
		}
		// The entry is in the map before the first read suspends, so a concurrent request marks it instead of
		// starting its own recompute. A second pass runs only when a request arrived during the first.
		const entry = { again: false, done: Promise.resolve<SessionState>("idle") };
		entry.done = (async () => {
			try {
				let state: SessionState = "idle";
				do {
					entry.again = false;
					state = await compute(sessionId);
				} while (entry.again);
				return state;
			} finally {
				this.#running.delete(sessionId);
			}
		})();
		this.#running.set(sessionId, entry);
		return entry.done;
	}

	/** Whether a recompute of the session is in flight. */
	isRunning(sessionId: string): boolean {
		return this.#running.has(sessionId);
	}
}

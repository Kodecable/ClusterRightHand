import { KeyedReconciler } from "../../util/keyed-reconciler.ts";
import type { SessionState } from "../session-state.ts";

/**
 * The per-session state recomputations in flight (doc/design/agent-runtime.md "Session state").
 *
 * Refreshes of one session are serialized and coalesced: a request while one runs marks it dirty and
 * shares its promise, and the running one recomputes once more after it finishes, so the last write is always
 * computed from data read after the latest request. A throwing recompute still removes its entry.
 */
export class StateRefreshes {
	readonly #reconciler = new KeyedReconciler<SessionState>();

	/** Recomputes `sessionId` with `compute`, or joins the recompute already running for it. */
	run(sessionId: string, compute: (sessionId: string) => Promise<SessionState>): Promise<SessionState> {
		return this.#reconciler.run(sessionId, compute);
	}

	/** Whether a recompute of the session is in flight. */
	isRunning(sessionId: string): boolean {
		return this.#reconciler.isRunning(sessionId);
	}

	/** Waits until no recompute is in flight; close() calls this before it closes the Harness. */
	async drain(): Promise<void> {
		await this.#reconciler.drain();
	}
}

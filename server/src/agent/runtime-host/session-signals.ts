import type { SessionEvent } from "../runtime-core.ts";

/**
 * Events the runtime puts on a session's stream that a durable commit cannot carry, because the run is being
 * stopped rather than advanced. Today there is one: the `task_failed` a parked task's stop reports, so the
 * WebUI's banner tells the owner why the run ended (doc/design/agent-runtime.md "Session state").
 *
 * Memory only, like the Harness's own failure events: a client that connects after the event sees the run
 * ended and is told nothing more. Nothing durable records it, deliberately: the stop runs while the storage
 * that would carry the record is the thing that keeps failing.
 */
export class SessionSignals {
	readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();

	/** Adds a listener for the session's stream; the returned function removes it. */
	subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
		const listeners = this.#listeners.get(sessionId) ?? new Set<(event: SessionEvent) => void>();
		this.#listeners.set(sessionId, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0 && this.#listeners.get(sessionId) === listeners) this.#listeners.delete(sessionId);
		};
	}

	/** Sends one event to every stream open on the session right now. */
	publish(sessionId: string, event: SessionEvent): void {
		for (const listener of this.#listeners.get(sessionId) ?? []) listener(event);
	}
}

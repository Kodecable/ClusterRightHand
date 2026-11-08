/**
 * Transient per-session flags, never persisted: a stop in flight (runtime-sessions.ts, runtime-state.ts) and a
 * title generation in flight (title.ts).
 */
export class SessionFlags {
	readonly #stopping = new Set<string>();
	readonly #titleGenerating = new Set<string>();

	/** Marks a stop in flight: its run ends during the stop, and the stop, not the run end, ends its waits. */
	beginStop(sessionId: string): void {
		this.#stopping.add(sessionId);
	}

	/** Clears the stop mark once every conversation and wait of the tree is settled. */
	endStop(sessionId: string): void {
		this.#stopping.delete(sessionId);
	}

	isStopping(sessionId: string): boolean {
		return this.#stopping.has(sessionId);
	}

	/** Marks a title generation in flight; false when one is already running for the session. */
	beginTitle(sessionId: string): boolean {
		if (this.#titleGenerating.has(sessionId)) return false;
		this.#titleGenerating.add(sessionId);
		return true;
	}

	endTitle(sessionId: string): void {
		this.#titleGenerating.delete(sessionId);
	}
}

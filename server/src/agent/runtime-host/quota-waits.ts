/**
 * The in-memory side of quota waits (runtime-quota.ts, doc/design/agent-runtime.md "Quota and token accounting"): the calls paused on each
 * session's quota, and the sessions whose wait was denied while their call was setting up or between waits.
 */
export class QuotaWaits {
	readonly #waiters = new Map<string, Set<() => void>>();
	readonly #denied = new Set<string>();

	/** Registers a wake-up for the session; the returned function removes it again. */
	wait(sessionId: string, wake: () => void): () => void {
		const existing = this.#waiters.get(sessionId);
		const waiters = existing ?? new Set<() => void>();
		if (!existing) this.#waiters.set(sessionId, waiters);
		waiters.add(wake);
		return () => {
			waiters.delete(wake);
			if (waiters.size === 0) this.#waiters.delete(sessionId);
		};
	}

	/** Whether a call is paused on the session's quota right now. */
	hasWaiters(sessionId: string): boolean {
		return (this.#waiters.get(sessionId)?.size ?? 0) > 0;
	}

	/** Wakes every paused call; a grant, deny, abort or quota edit calls this. */
	wakeAll(): void {
		for (const waiters of this.#waiters.values()) for (const wake of waiters) wake();
	}

	/** Marks a waited session as denied, so its paused call ends instead of waiting again. */
	markDenied(sessionId: string): void {
		this.#denied.add(sessionId);
	}

	/** Consumes the denied mark; true when the session's wait was denied. */
	takeDenied(sessionId: string): boolean {
		return this.#denied.delete(sessionId);
	}

	/** Clears the denied mark of a session that is being stopped or restarted. */
	clearDenied(sessionId: string): void {
		this.#denied.delete(sessionId);
	}

	/** Forgets a removed session's wait: drops the denied mark, wakes its waiters, then drops them. */
	forget(sessionId: string): void {
		this.#denied.delete(sessionId);
		const waiters = this.#waiters.get(sessionId);
		if (waiters) {
			for (const wake of [...waiters]) wake();
			this.#waiters.delete(sessionId);
		}
	}
}

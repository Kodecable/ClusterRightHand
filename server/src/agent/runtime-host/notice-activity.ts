/**
 * Completion-notice deliveries in flight per session (wakes.ts, doc/design/jobs.md "Scheduled runs"): a
 * scheduled run is final only when its session is idle and no notice delivery or queued wake can still start a
 * turn. Deliveries bump a per-session sequence so a waiter that read the sequence before checking cannot miss
 * one, and nothing polls.
 */
export class NoticeActivity {
	readonly #active = new Map<string, number>();
	readonly #seq = new Map<string, number>();
	readonly #waiters = new Map<string, Set<() => void>>();

	/** A delivery began; its end notifies the waiters. */
	begin(sessionId: string): void {
		this.#active.set(sessionId, (this.#active.get(sessionId) ?? 0) + 1);
		this.#bump(sessionId);
	}

	end(sessionId: string): void {
		const left = (this.#active.get(sessionId) ?? 1) - 1;
		if (left <= 0) this.#active.delete(sessionId);
		else this.#active.set(sessionId, left);
		this.#bump(sessionId);
	}

	/** Whether a delivery of this session is in flight. */
	active(sessionId: string): boolean {
		return (this.#active.get(sessionId) ?? 0) > 0;
	}

	/** The session's change counter, read before checking the quiet condition. */
	seq(sessionId: string): number {
		return this.#seq.get(sessionId) ?? 0;
	}

	/** Notifies the waiters without an activity change (a queued wake was dropped, say). */
	notify(sessionId: string): void {
		this.#bump(sessionId);
	}

	/** Resolves after the next change since `seq`; an earlier change returns at once. Abort resolves too. */
	waitForChange(sessionId: string, seq: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			const finish = () => {
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			if (signal?.aborted || this.seq(sessionId) !== seq) {
				finish();
				return;
			}
			const waiters = this.#waiters.get(sessionId) ?? new Set<() => void>();
			this.#waiters.set(sessionId, waiters);
			const wake = () => {
				waiters.delete(wake);
				if (waiters.size === 0 && this.#waiters.get(sessionId) === waiters) this.#waiters.delete(sessionId);
				finish();
			};
			waiters.add(wake);
			signal?.addEventListener("abort", wake, { once: true });
		});
	}

	/** Forgets a removed session's state. */
	forget(sessionId: string): void {
		this.#active.delete(sessionId);
		this.#seq.delete(sessionId);
		this.#waiters.delete(sessionId);
	}

	#bump(sessionId: string): void {
		this.#seq.set(sessionId, (this.#seq.get(sessionId) ?? 0) + 1);
		const waiters = this.#waiters.get(sessionId);
		if (!waiters) return;
		for (const wake of [...waiters]) wake();
	}
}

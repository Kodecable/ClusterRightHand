/**
 * Serializes and coalesces level-triggered reconciliation by key: work for one key never overlaps, a
 * request while one runs marks it dirty and shares its promise, and the running pass runs once more
 * after it finishes. The result every caller sees is computed from data read after the latest request.
 * An entry is removed when its pass finishes, also when it throws.
 *
 * Use this for consumers of state-change notifications: the notification is only a hint, the pass reads
 * the current state and compares it with what it already did (doc/design/architecture.md "Concurrency").
 */
export class KeyedReconciler<T = unknown> {
	/** The running pass per key: its promise and whether a request arrived during it. */
	readonly #runs = new Map<string, { again: boolean; done: Promise<T> }>();

	/** Runs `compute` for `key`, or joins the pass already running for it and asks for one more. */
	run(key: string, compute: (key: string) => Promise<T>): Promise<T> {
		const running = this.#runs.get(key);
		if (running) {
			running.again = true;
			return running.done;
		}
		const resolved = Promise.withResolvers<T>();
		const entry = { again: false, done: resolved.promise };
		// The entry is in the map before `compute` runs, so a concurrent request marks this pass instead of
		// starting its own. A second pass runs only when a request arrived during the first.
		this.#runs.set(key, entry);
		void (async () => {
			try {
				let result: T = undefined as T;
				let first = true;
				do {
					// The first pass keeps a request that arrived before `compute` began; later passes clear the
					// mark before reading, so only a request during that pass asks for yet another one.
					if (!first) entry.again = false;
					first = false;
					result = await compute(key);
				} while (entry.again);
				resolved.resolve(result);
			} catch (err) {
				resolved.reject(err);
			} finally {
				if (this.#runs.get(key) === entry) this.#runs.delete(key);
			}
		})();
		return entry.done;
	}

	/** Whether a pass for the key is in flight. */
	isRunning(key: string): boolean {
		return this.#runs.has(key);
	}

	/**
	 * Resolves once no pass is in flight for any key, an extra pass a request asked for included. A caller may
	 * add another pass while this waits, so it keeps waiting until none is left; a failed pass counts as done.
	 */
	async drain(): Promise<void> {
		while (this.#runs.size > 0) {
			await Promise.allSettled([...this.#runs.values()].map((entry) => entry.done));
		}
	}
}

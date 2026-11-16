/**
 * Shares one idempotent creation per key: concurrent callers of `run` get the same promise, and the
 * entry is removed when the flight settles, successfully or not.
 *
 * Use this only for idempotent creation (a cache fill or one "find or create"): work that must run
 * every time belongs in KeyedQueue or KeyedReconciler (doc/design/architecture.md "Concurrency").
 */
export class SingleFlight<T = unknown> {
	/** The creation in flight per key. */
	readonly #flights = new Map<string, Promise<T>>();

	/** Starts the creation for `key`, or joins the one already in flight. */
	run(key: string, create: () => Promise<T>): Promise<T> {
		const existing = this.#flights.get(key);
		if (existing) return existing;
		// The entry is in the map before `create` can run (the promise defers it a microtask), so a concurrent
		// caller joins this flight instead of starting another.
		const flight = Promise.resolve()
			.then(create)
			.finally(() => {
				if (this.#flights.get(key) === flight) this.#flights.delete(key);
			});
		this.#flights.set(key, flight);
		return flight;
	}

	/** Whether a creation for the key is in flight. */
	isRunning(key: string): boolean {
		return this.#flights.has(key);
	}

	/** The creation in flight for the key, so a caller can wait for it without starting one. */
	current(key: string): Promise<T> | undefined {
		return this.#flights.get(key);
	}

	/** How many keys have a creation in flight. */
	get size(): number {
		return this.#flights.size;
	}
}

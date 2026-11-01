/**
 * Serializes asynchronous work by key: work with the same key runs one piece after another, work with
 * different keys runs concurrently. A failing piece does not stop the key's later pieces; the key is
 * forgotten once its last piece has settled.
 */
export class KeyedQueue {
	/** Names the queue in the log line of a failed cleanup, e.g. "task queue". */
	readonly #label: string;
	/** The work still to run per key: what a newly queued piece waits for. */
	readonly #tails = new Map<string, Promise<void>>();

	constructor(label: string) {
		this.#label = label;
	}

	/** Runs `fn` after the work already queued for `key`, and resolves with `fn`'s own result. */
	run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const next = (this.#tails.get(key) ?? Promise.resolve()).then(fn);
		const tail: Promise<void> = next.then(
			() => {},
			() => {},
		);
		this.#tails.set(key, tail);
		void tail
			.then(() => {
				if (this.#tails.get(key) === tail) this.#tails.delete(key);
			})
			.catch((err: unknown) => console.error(`${this.#label} cleanup failed:`, err));
		return next;
	}

	/** What the key still has to run; resolves at once for an idle key (a caller waits for the queue). */
	tail(key: string): Promise<void> {
		return this.#tails.get(key) ?? Promise.resolve();
	}

	/** The tails of every key with work, for a caller that drains the queues (close()). */
	get pending(): Promise<void>[] {
		return [...this.#tails.values()];
	}

	/** How many keys have work; a drained queue has none. */
	get size(): number {
		return this.#tails.size;
	}
}

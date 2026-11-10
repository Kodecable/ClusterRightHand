/**
 * Serializes asynchronous work by key: work with the same key runs one piece after another, work with
 * different keys runs concurrently. A failing piece does not stop the key's later pieces; the key is
 * forgotten once its last piece has settled.
 *
 * A piece is a *turn*: every run() is tracked with AsyncLocalStorage, so code running inside it
 * can ask whether it is in a turn (and which), and the task queue can refuse work that waits for a node
 * while it holds a task's slot. Turns nest (taskQueue → groupQueue → trustQueue), so a stack is kept.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** One queue turn in progress: the queue's label and the key it works on. */
export interface QueueTurn {
	readonly queue: string;
	readonly key: string;
}

/** A turn plus the queue instance, so inTurn() can tell the queues apart even if labels collide. */
interface TurnFrame extends QueueTurn {
	readonly owner: KeyedQueue;
}

/** The turns of the current async flow, outermost first. */
const activeTurns = new AsyncLocalStorage<readonly TurnFrame[]>();

/** Every queue turn the current async flow is inside, outermost first (a violation reports them). */
export function currentTurns(): readonly QueueTurn[] {
	return (activeTurns.getStore() ?? []).map(({ queue, key }) => ({ queue, key }));
}

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
		const next = (this.#tails.get(key) ?? Promise.resolve()).then(() => {
			// The turn is visible to everything `fn` awaits, and only to it: a later piece of another key
			// or a background task is not inside it.
			const turns = activeTurns.getStore() ?? [];
			return activeTurns.run([...turns, { queue: this.#label, key, owner: this }], fn);
		});
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

	/** Whether the current async flow is inside a turn of this queue, for any key. */
	inTurn(): boolean {
		return activeTurns.getStore()?.some((frame) => frame.owner === this) ?? false;
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

import { resolve } from "node:path";

/**
 * One SQLite file is opened twice (doc/design/data-model.md): Kysely for crhs's own tables and pi-durable's
 * storage for the agent runtime. node:sqlite is synchronous, so the two connections cannot contend for the
 * file's write lock without breaking: a deferred transaction that reads and then writes fails at once with
 * SQLITE_BUSY_SNAPSHOT (the busy handler is never consulted), and while one connection holds the write lock
 * the other's busy handler blocks the whole thread, including the transaction that must commit to release it.
 * Every statement of both connections therefore goes through one queue for the file: a statement takes its
 * turn, a transaction keeps the queue until it commits or rolls back.
 */
export class SqliteLock {
	#tail: Promise<void> = Promise.resolve();

	/** Runs `work` after everything queued before it; the queue is free again when it settles. */
	async run<T>(work: () => T | Promise<T>): Promise<T> {
		const result = this.#tail.then(work);
		this.#tail = result.then(done, done);
		return result;
	}

	/** Waits for the work queued so far, then keeps the queue until the returned function is called. */
	async hold(): Promise<() => void> {
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.#tail;
		this.#tail = previous.then(() => released);
		await previous;
		return release;
	}
}

const done = () => {};

/** The lock of each database file this process opened; every connection to the file shares it. */
const locks = new Map<string, SqliteLock>();

/**
 * The lock of a SQLite database. Every connection to one file must pass through it; each `:memory:` database
 * is a database of its own (nothing of it is shared), so it needs no queue.
 */
export function sqliteLock(path: string): SqliteLock {
	if (path === ":memory:") return new SqliteLock();
	const key = resolve(path);
	let lock = locks.get(key);
	if (!lock) {
		lock = new SqliteLock();
		locks.set(key, lock);
	}
	return lock;
}

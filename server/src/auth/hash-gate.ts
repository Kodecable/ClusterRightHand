/**
 * One process-wide gate in front of every Argon2id computation (server/src/auth/password.ts).
 *
 * Argon2id runs on libuv's threadpool, whose default size is 4, and each hash holds 64 MiB by
 * default. Without a gate a burst of logins would start one hash per request: it would exhaust the
 * threadpool (every other fs/DNS/crypto job waits behind it) and multiply the memory by the number
 * of requests. The gate lets at most `concurrency` hashes run and at most `queue` wait; beyond that
 * a request fails fast with HashBusyError (HTTP 503 `hash_busy`, Retry-After: 1).
 */
export class HashBusyError extends Error {
	constructor() {
		super("the server is busy, try again");
		this.name = "HashBusyError";
	}
}

/** Defaults match the config defaults ([auth] argon2_concurrency = 2, argon2_queue = 32). */
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE = 32;

let concurrency = DEFAULT_CONCURRENCY;
let queueLimit = DEFAULT_QUEUE;
let running = 0;
const waiting: Array<() => void> = [];

/** Configures the gate once at startup from `[auth]`; tests keep the defaults. */
export function configureHashGate(options: { concurrency: number; queue: number }): void {
	if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
		throw new RangeError("concurrency must be an integer >= 1");
	}
	if (!Number.isSafeInteger(options.queue) || options.queue < 0) {
		throw new RangeError("queue must be an integer >= 0");
	}
	concurrency = options.concurrency;
	queueLimit = options.queue;
}

/**
 * Runs `compute` once a slot is free. A slot is handed directly from the finishing computation to
 * the next waiter, so `running` never exceeds `concurrency`.
 */
export async function withHashSlot<T>(compute: () => Promise<T>): Promise<T> {
	if (running >= concurrency) {
		if (waiting.length >= queueLimit) throw new HashBusyError();
		await new Promise<void>((resolve) => waiting.push(resolve));
	} else {
		running++;
	}
	try {
		return await compute();
	} finally {
		const next = waiting.shift();
		// A waiter already has the slot; only an idle gate gives the slot back.
		if (next) next();
		else running--;
	}
}

/** Test helper: resets the gate to the configured defaults (or the given values). */
export function resetHashGateForTesting(
	options: { concurrency: number; queue: number } = {
		concurrency: DEFAULT_CONCURRENCY,
		queue: DEFAULT_QUEUE,
	},
): void {
	if (running !== 0 || waiting.length !== 0) throw new Error("the hash gate is not idle");
	configureHashGate(options);
}

/**
 * One process-wide gate in front of every Argon2id computation (server/src/auth/password.ts).
 *
 * Argon2id runs on libuv's threadpool, whose default size is 4, and each hash holds 64 MiB by
 * default. Without a gate a burst of logins would start one hash per request: it would exhaust the
 * threadpool (every other fs/DNS/crypto job waits behind it) and multiply the memory by the number
 * of requests. The gate lets at most `concurrency` hashes run and at most `queue` wait; beyond that
 * a request fails fast with HashBusyError (HTTP 503 `hash_busy`, Retry-After: 1).
 *
 * Two callers share the gate. A `login` hash is what lets a user in, so it may use every slot and
 * the whole queue. `other` hashes (a password change, a reset, user creation) are capped at
 * `concurrency - 1` running hashes when there are at least 2 slots, and at half the queue; a
 * logged-in user can therefore never take the last slot and make site-wide login answer 503. With
 * `concurrency = 1` there is no spare slot to reserve; the cap is the one slot and both kinds are
 * equal.
 */
export class HashBusyError extends Error {
	constructor() {
		super("the server is busy, try again");
		this.name = "HashBusyError";
	}
}

/** Why a computation wants a slot: a login must always find one; everything else yields to it. */
export type HashKind = "login" | "other";

/** Defaults match the config defaults ([auth] argon2_concurrency = 2, argon2_queue = 32). */
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_QUEUE = 32;

let concurrency = DEFAULT_CONCURRENCY;
let queueLimit = DEFAULT_QUEUE;
const running = { login: 0, other: 0 };
type Waiter = { kind: HashKind; resolve: () => void };
const waiting: Waiter[] = [];

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

/** The most slots `other` may hold: every slot but one reserved for a login (when there are two). */
function otherSlotLimit(): number {
	return concurrency >= 2 ? concurrency - 1 : 1;
}

/** The share of the queue `other` may use: at most half, so login requests still fit. */
function otherQueueLimit(): number {
	return queueLimit === 0 ? 0 : Math.max(1, Math.floor(queueLimit / 2));
}

function runningTotal(): number {
	return running.login + running.other;
}

function canRun(kind: HashKind): boolean {
	if (runningTotal() >= concurrency) return false;
	return kind === "login" || running.other < otherSlotLimit();
}

/** Hands every free slot to a login waiter first, then to `other` waiters. */
function pump(): void {
	for (;;) {
		const login = waiting.findIndex((waiter) => waiter.kind === "login");
		if (login >= 0 && canRun("login")) {
			const [waiter] = waiting.splice(login, 1);
			running.login++;
			waiter?.resolve();
			continue;
		}
		const other = waiting.findIndex((waiter) => waiter.kind === "other");
		if (other >= 0 && canRun("other")) {
			const [waiter] = waiting.splice(other, 1);
			running.other++;
			waiter?.resolve();
			continue;
		}
		return;
	}
}

/**
 * Runs `compute` once a slot is free, under the queue and per-kind caps above. A given slot is
 * always taken by a login waiter first, so `other` hashes can never starve logins out of the queue.
 */
export async function withHashSlot<T>(compute: () => Promise<T>, kind: HashKind = "other"): Promise<T> {
	// A login may pass a queue of waiting "other" hashes; other hashes queue behind every waiter.
	const startNow = canRun(kind) && (kind === "login" || waiting.length === 0);
	if (!startNow) {
		if (waiting.length >= queueLimit) throw new HashBusyError();
		if (kind === "other" && waiting.filter((waiter) => waiter.kind === "other").length >= otherQueueLimit()) {
			throw new HashBusyError();
		}
		await new Promise<void>((resolve) => waiting.push({ kind, resolve }));
	}
	// A waiter woken by pump() already has its slot counted; a direct start counts it here.
	if (startNow) running[kind]++;
	try {
		return await compute();
	} finally {
		running[kind]--;
		pump();
	}
}

/** Test helper: resets the gate to the configured defaults (or the given values). */
export function resetHashGateForTesting(
	options: { concurrency: number; queue: number } = {
		concurrency: DEFAULT_CONCURRENCY,
		queue: DEFAULT_QUEUE,
	},
): void {
	if (runningTotal() !== 0 || waiting.length !== 0) throw new Error("the hash gate is not idle");
	configureHashGate(options);
}

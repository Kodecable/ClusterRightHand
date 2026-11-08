/**
 * In-memory limiter for failed logins, keyed by client address and by address + username.
 *
 * It is per process and resets on restart; that is enough to stop online guessing against one
 * crhs. The attempt is reserved (counted as a failure) before Argon2id runs, so a burst of
 * concurrent requests cannot all pass the check. A successful login only clears the address+user
 * key and gives back its own reservation on the address key; other usernames stay limited.
 */

/** The keys one login attempt is counted under. */
export interface LoginAttemptKeys {
	/** Every key the blocked check looks at. */
	all: string[];
	/** `addr:<address>`; undefined when the tests have no socket (no address is known). */
	addressKey: string | undefined;
	/** `addr-user:<address>\0<lowercased trimmed username>`. */
	userKey: string;
}

export function loginAttemptKeys(address: string | undefined, username: string): LoginAttemptKeys {
	const userKey = `addr-user:${address ?? ""}\0${username.trim().toLowerCase()}`;
	const addressKey = address === undefined ? undefined : `addr:${address}`;
	return { all: addressKey === undefined ? [userKey] : [userKey, addressKey], addressKey, userKey };
}

export class LoginLimiter {
	readonly #failures = new Map<string, { count: number; resetAt: number }>();
	readonly #inFlight = new Set<string>();

	readonly maxFailures: number;
	readonly windowMs: number;

	constructor(maxFailures = 10, windowMs = 15 * 60 * 1000) {
		this.maxFailures = maxFailures;
		this.windowMs = windowMs;
	}

	isBlocked(keys: string[], now = Date.now()): boolean {
		return keys.some((key) => {
			const entry = this.#failures.get(key);
			return entry !== undefined && entry.resetAt > now && entry.count >= this.maxFailures;
		});
	}

	/**
	 * One synchronous check-and-increment: returns false without counting when a key is blocked,
	 * otherwise counts this attempt as a failure and returns true. Call it before hashing.
	 */
	reserve(keys: string[], now = Date.now()): boolean {
		if (this.isBlocked(keys, now)) return false;
		this.recordFailure(keys, now);
		return true;
	}

	recordFailure(keys: string[], now = Date.now()): void {
		for (const key of keys) {
			const entry = this.#failures.get(key);
			if (!entry || entry.resetAt <= now) {
				this.#failures.set(key, { count: 1, resetAt: now + this.windowMs });
			} else {
				entry.count++;
			}
		}
		if (this.#failures.size > 10_000) this.#prune(now);
	}

	/** A successful login clears this address+username pair; the address key is left alone. */
	clearUser(userKey: string): void {
		this.#failures.delete(userKey);
	}

	/** Gives back one reserved attempt on a key, keeping earlier failures intact. */
	refund(key: string, now = Date.now()): void {
		const entry = this.#failures.get(key);
		if (!entry || entry.resetAt <= now) return;
		if (entry.count <= 1) this.#failures.delete(key);
		else entry.count--;
	}

	/** True when this address may enter the verify step; false while another login is inside it. */
	beginVerify(address: string): boolean {
		if (this.#inFlight.has(address)) return false;
		this.#inFlight.add(address);
		return true;
	}

	endVerify(address: string): void {
		this.#inFlight.delete(address);
	}

	/** Drops every key (used when the whole limiter is reset, e.g. by a test). */
	reset(keys: string[]): void {
		for (const key of keys) this.#failures.delete(key);
	}

	#prune(now: number): void {
		for (const [key, entry] of this.#failures) {
			if (entry.resetAt <= now) this.#failures.delete(key);
		}
	}
}

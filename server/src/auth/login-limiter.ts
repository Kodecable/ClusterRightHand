/**
 * In-memory limiter for failed logins, keyed by username and by client address separately.
 * It is per process and resets on restart; that is enough to stop online guessing against one crhs.
 */
export class LoginLimiter {
	readonly #failures = new Map<string, { count: number; resetAt: number }>();

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

	reset(keys: string[]): void {
		for (const key of keys) this.#failures.delete(key);
	}

	#prune(now: number): void {
		for (const [key, entry] of this.#failures) {
			if (entry.resetAt <= now) this.#failures.delete(key);
		}
	}
}

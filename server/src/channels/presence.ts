/**
 * Whether a user is online in the WebUI (doc/design/channels.md "Notifications"): a WebUI request in the last ten
 * minutes, or an open event stream (the session list or a session's events). crhs is one process, so this is kept
 * in memory.
 */

const ONLINE_WINDOW_MS = 10 * 60_000;

export class WebUiPresence {
	readonly #lastRequest = new Map<string, number>();
	readonly #streams = new Map<string, number>();
	readonly #now: () => number;
	readonly #windowMs: number;

	constructor(options: { now?: () => number; windowMs?: number } = {}) {
		this.#now = options.now ?? Date.now;
		this.#windowMs = options.windowMs ?? ONLINE_WINDOW_MS;
	}

	/** A WebUI request by the user. */
	touch(userId: string): void {
		this.#lastRequest.set(userId, this.#now());
	}

	openStream(userId: string): void {
		this.#streams.set(userId, (this.#streams.get(userId) ?? 0) + 1);
	}

	closeStream(userId: string): void {
		const count = this.#streams.get(userId) ?? 0;
		if (count <= 1) this.#streams.delete(userId);
		else this.#streams.set(userId, count - 1);
	}

	online(userId: string): boolean {
		if ((this.#streams.get(userId) ?? 0) > 0) return true;
		const last = this.#lastRequest.get(userId);
		return last !== undefined && this.#now() - last <= this.#windowMs;
	}

	/** Forget a user entirely (disabled, deleted); tests and user deletion use it. */
	forget(userId: string): void {
		this.#lastRequest.delete(userId);
		this.#streams.delete(userId);
	}
}

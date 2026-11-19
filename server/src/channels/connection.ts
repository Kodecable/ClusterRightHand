import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelay } from "../util/backoff.ts";
import { errorText } from "../util/errors.ts";
import type { ChannelStatus } from "./model.ts";

/**
 * Connection lifecycle shared by channel kinds (doc/design/channels.md "Channels"): connect, retry with the
 * extension backoff (1 s doubling with jitter, capped at 5 minutes) and expose the state, last error and next
 * attempt the admin page shows. A successful connection resets the schedule.
 */

export interface ChannelConnectionOptions {
	baseMs?: number;
	maxMs?: number;
	/** Injected in tests; the adapter's attempt is skipped instead. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		timer.unref?.();
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

export abstract class ChannelConnection {
	readonly #baseMs: number;
	readonly #maxMs: number;
	readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	#status: ChannelStatus = { state: "disabled", lastError: null, nextAttemptAt: null, account: null };
	#attempt = 0;
	#abort: AbortController | null = null;
	#done: Promise<void> | null = null;
	#stopping = false;

	constructor(options: ChannelConnectionOptions = {}) {
		this.#baseMs = options.baseMs ?? BACKOFF_BASE_MS;
		this.#maxMs = options.maxMs ?? BACKOFF_MAX_MS;
		this.#sleep = options.sleep ?? sleepFor;
	}

	/** One connection attempt that runs until `signal` aborts; a throw means the attempt failed. */
	protected abstract run(signal: AbortSignal): Promise<void>;

	/** Releases platform resources after the loop ends; a no-op by default. */
	protected async close(): Promise<void> {}

	/** Starts the connection loop; repeated calls while one runs are no-ops. */
	start(): void {
		if (this.#done !== null) return;
		this.#stopping = false;
		this.#abort = new AbortController();
		this.#done = this.#loop(this.#abort.signal);
	}

	/** Stops the loop and closes the platform client. */
	async stop(): Promise<void> {
		this.#stopping = true;
		this.#abort?.abort();
		await this.#done;
		this.#done = null;
		this.#abort = null;
		this.#status = { ...this.#status, state: "disabled", nextAttemptAt: null };
		await this.close();
	}

	status(): ChannelStatus {
		return { ...this.#status };
	}

	/**
	 * `timeoutMs` as an AbortSignal, combined with the running loop's stop signal when there is one. Covers
	 * calls made outside `run`, such as an API call or a file download, without outliving the connection.
	 */
	protected timeoutSignal(timeoutMs: number): AbortSignal {
		const timeout = AbortSignal.timeout(timeoutMs);
		const stop = this.#abort?.signal;
		return stop === undefined ? timeout : AbortSignal.any([timeout, stop]);
	}

	/** Marks a successful connection; `account` is the bot's label when the platform reported one. */
	protected markConnected(account?: string | null): void {
		this.#attempt = 0;
		this.#status = {
			state: "connected",
			lastError: null,
			nextAttemptAt: null,
			account: account === undefined ? this.#status.account : account,
		};
	}

	/** Records an error during an otherwise healthy connection without dropping to backoff. */
	protected markError(message: string): void {
		this.#status = { ...this.#status, lastError: this.redact(message) };
	}

	/** Removes credentials from an error before it is kept for the admin page; a channel overrides it. */
	protected redact(message: string): string {
		return message;
	}

	async #loop(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			this.#status = {
				...this.#status,
				state: this.#attempt === 0 ? "connecting" : "unavailable",
				nextAttemptAt: null,
			};
			try {
				await this.run(signal);
				if (signal.aborted) break;
				throw new Error("the connection closed");
			} catch (err) {
				if (signal.aborted) break;
				this.#attempt += 1;
				const message = this.redact(errorText(err));
				this.#status = { ...this.#status, state: "unavailable", lastError: message };
				const delay = backoffDelay(this.#attempt, { baseMs: this.#baseMs, maxMs: this.#maxMs });
				this.#status = { ...this.#status, nextAttemptAt: new Date(Date.now() + delay).toISOString() };
				await this.#sleep(delay, signal);
			}
		}
		if (this.#stopping) {
			this.#status = { ...this.#status, state: "disabled", nextAttemptAt: null };
		}
	}
}

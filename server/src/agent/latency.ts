/**
 * Per-step latency (doc/agent-runtime.md#会话统计): the time to the first streamed delta and the decode time
 * after it. Timing is measured at the provider stream, in `meteredModels` (metering.ts): every generation call
 * the Harness makes carries its conversation's provider session id, so a step is timed whether or not a browser
 * or any other client watches the session, and the timing cannot be lost to an event-stream boundary. The map is
 * in memory and keyed by provider session id; extension.ts takes the entry when the message ends.
 */

/** One generation attempt's monotonic timestamps, from `performance.now()`. */
export interface AttemptTiming {
	/** When the provider stream was requested. */
	start: number;
	/** The first event that carried output (a text, thinking or tool-call delta, or a partial with content). */
	first?: number;
	/** When the stream ended (its done or error event). */
	end?: number;
}

/**
 * Where a generation stream's timing goes. `meteredModels` calls `begin` before requesting the stream, then
 * `noteFirst` and `finish` as its events arrive; `clear` drops an attempt whose request failed.
 */
export interface TimingSink {
	begin(providerSessionId: string): void;
	noteFirst(providerSessionId: string): void;
	finish(providerSessionId: string): void;
	clear(providerSessionId: string): void;
}

/**
 * How many provider sessions may hold an unfinished attempt. An attempt is normally taken when its message
 * ends or cleared when its session is stopped; the cap only bounds entries whose stream never ended (a provider
 * that never answers, a process that lost the session), which would otherwise grow without bound.
 */
export const MAX_PENDING_TIMINGS = 1_000;

/** The attempts currently streaming, one per provider session (doc/agent-runtime.md#会话统计). */
export class GenerationTimings implements TimingSink {
	readonly #attempts = new Map<string, AttemptTiming>();

	/**
	 * Starts an attempt, replacing the provider session's previous one: a retry's new call is a new attempt and
	 * the earlier timestamps are gone. A new session at the cap evicts the oldest entry.
	 */
	begin(providerSessionId: string, at: number = performance.now()): void {
		if (!this.#attempts.has(providerSessionId) && this.#attempts.size >= MAX_PENDING_TIMINGS) {
			const oldest = this.#attempts.keys().next().value;
			if (oldest !== undefined) this.#attempts.delete(oldest);
		}
		this.#attempts.set(providerSessionId, { start: at });
	}

	/** Records the first event carrying content; later events keep the first time. */
	noteFirst(providerSessionId: string, at: number = performance.now()): void {
		const attempt = this.#attempts.get(providerSessionId);
		if (attempt && attempt.first === undefined) attempt.first = at;
	}

	/** Records the stream's end (its done or error event). */
	finish(providerSessionId: string, at: number = performance.now()): void {
		const attempt = this.#attempts.get(providerSessionId);
		if (attempt) attempt.end = at;
	}

	/** Reads and forgets the attempt: its message ended and the hook took the timing. */
	take(providerSessionId: string): AttemptTiming | undefined {
		const attempt = this.#attempts.get(providerSessionId);
		this.#attempts.delete(providerSessionId);
		return attempt;
	}

	/** Drops an attempt without reading it: an abort, a teardown, or a call that failed before streaming. */
	clear(providerSessionId: string): void {
		this.#attempts.delete(providerSessionId);
	}

	/** Drops every attempt; the runtime is closing. */
	clearAll(): void {
		this.#attempts.clear();
	}

	/** How many provider sessions hold an attempt; at most one entry each, and at most MAX_PENDING_TIMINGS. */
	get size(): number {
		return this.#attempts.size;
	}
}

/** The latency increments one step contributes to the session's counters. */
export interface StepTiming {
	/** Time from the request start to the first streamed delta, in ms. */
	ttftMs: number;
	/** Time from the first delta to the message end, in ms. */
	decodeMs: number;
	/** Output tokens the message reported (`usage.output`). */
	outputTokens: number;
}

/**
 * One step's timing from its attempt's monotonic timestamps: the request start S, the first event carrying
 * content F and the stream end E, so `ttft = F − S` and `decode = E − F`, both clamped at 0. Undefined when
 * there is nothing to measure: no attempt, no observed content or no observed end (a call that produced no
 * content has no decode rate either), or no output tokens.
 */
export function stepTiming(attempt: AttemptTiming | undefined, outputTokens: number): StepTiming | undefined {
	if (!attempt) return undefined;
	const { start, first, end } = attempt;
	if (!Number.isFinite(start)) return undefined;
	if (first === undefined || !Number.isFinite(first)) return undefined;
	if (end === undefined || !Number.isFinite(end)) return undefined;
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined;
	return {
		ttftMs: Math.max(0, Math.round(first - start)),
		decodeMs: Math.max(0, Math.round(end - first)),
		outputTokens: Math.max(0, Math.round(outputTokens)),
	};
}

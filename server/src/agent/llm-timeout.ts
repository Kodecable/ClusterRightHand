import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";

/**
 * Bounds on one auxiliary model call (Auto Review and title generation): a stream that sends nothing for
 * `idleMs` is stalled, and no call may run longer than `overallMs` even while it keeps streaming. Provider
 * SDKs otherwise wait forever on a connection that half-opened, so the review would never reach the user.
 */
export interface LlmTimeoutLimits {
	/** Longest silence between two stream events, in milliseconds. */
	idleMs: number;
	/** Longest total call, in milliseconds. */
	overallMs: number;
}

export const LLM_IDLE_TIMEOUT_MS = 300_000;
export const LLM_OVERALL_TIMEOUT_MS = 600_000;

export const DEFAULT_LLM_TIMEOUTS: LlmTimeoutLimits = {
	idleMs: LLM_IDLE_TIMEOUT_MS,
	overallMs: LLM_OVERALL_TIMEOUT_MS,
};

/** Which limit cut the stream. */
export type LlmTimeoutKind = "idle" | "overall";

/** A stream that stalled or outlived its overall limit; callers word their own user-facing reason. */
export class LlmTimeoutError extends Error {
	readonly kind: LlmTimeoutKind;

	constructor(kind: LlmTimeoutKind) {
		super(kind === "idle" ? "the model stream stalled" : "the model call took too long");
		this.name = "LlmTimeoutError";
		this.kind = kind;
	}
}

/** A signal that aborted the call from outside (a stopped turn or an aborted tool call). */
export class LlmAbortedError extends Error {
	readonly reason: unknown;

	constructor(reason: unknown) {
		super("the model call was aborted");
		this.name = "LlmAbortedError";
		this.reason = reason;
	}
}

export interface LlmStreamOptions {
	/** Limits, usually from `ModelConfig.llmTimeouts`; defaults to the production constants. */
	limits?: LlmTimeoutLimits;
	/** The caller's signal (tool abort, turn stop); it aborts the stream as well. */
	signal?: AbortSignal;
	/** Called for every event as it arrives, after the idle limit is reset. */
	onEvent?: (event: unknown) => void;
}

/**
 * Runs one `streamSimple` call under the idle and overall limits and returns its final message, which is
 * what `completeSimple` would have returned (an error event resolves as an error message, not a rejection).
 *
 * The stream is opened with an `AbortSignal` that combines the caller's signal with a controller of our own,
 * so a stalled or overlong call also stops the provider request. The idle limit resets on every event,
 * thinking deltas included: a model that keeps reasoning is not stalled. A timeout throws `LlmTimeoutError`;
 * an aborted caller signal throws `LlmAbortedError`, so the review can keep the two reasons apart.
 */
export async function streamSimpleWithTimeouts(
	open: (signal: AbortSignal) => AssistantMessageEventStream,
	options: LlmStreamOptions = {},
): Promise<AssistantMessage> {
	const limits = options.limits ?? DEFAULT_LLM_TIMEOUTS;
	const controller = new AbortController();
	const external = options.signal;
	const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
	let timedOut: LlmTimeoutKind | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let overallTimer: ReturnType<typeof setTimeout> | undefined;
	let rejectLimit!: (error: Error) => void;
	const limitReached = new Promise<never>((_resolve, reject) => {
		rejectLimit = reject;
	});
	// The race below may settle with the limit while the stream is still winding down; this keeps the
	// rejection from becoming unhandled once the caller has already moved on.
	limitReached.catch(() => {});
	const fail = (kind: LlmTimeoutKind): void => {
		if (timedOut !== undefined) return;
		timedOut = kind;
		const error = new LlmTimeoutError(kind);
		rejectLimit(error);
		controller.abort(error);
	};
	const armIdle = (): void => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => fail("idle"), limits.idleMs);
		idleTimer.unref?.();
	};
	let iterator: AsyncIterator<unknown> | undefined;
	let externalListener: (() => void) | undefined;
	let aborted: Promise<never> | undefined;
	if (external) {
		aborted = new Promise<never>((_resolve, reject) => {
			externalListener = () => reject(new LlmAbortedError(external.reason));
			if (external.aborted) externalListener();
			else external.addEventListener("abort", externalListener, { once: true });
		});
		aborted.catch(() => {});
	}
	try {
		const stream = open(signal);
		iterator = stream[Symbol.asyncIterator]() as AsyncIterator<unknown>;
		armIdle();
		overallTimer = setTimeout(() => fail("overall"), limits.overallMs);
		overallTimer.unref?.();
		for (;;) {
			const next = iterator.next() as Promise<IteratorResult<unknown>>;
			const raced = aborted
				? await Promise.race([next, limitReached, aborted])
				: await Promise.race([next, limitReached]);
			if ((raced as IteratorResult<unknown>).done === true) break;
			armIdle();
			options.onEvent?.(raced);
		}
		return await stream.result();
	} catch (error) {
		if (timedOut !== undefined) throw new LlmTimeoutError(timedOut);
		throw error;
	} finally {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		if (overallTimer !== undefined) clearTimeout(overallTimer);
		if (externalListener) external?.removeEventListener("abort", externalListener);
		// A timed-out or aborted stream may still be winding down; asking it to stop keeps a provider
		// request from running in the background.
		if (timedOut !== undefined || external?.aborted) {
			void iterator?.return?.().catch?.(() => {});
		}
	}
}

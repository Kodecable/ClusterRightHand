/**
 * The retry delay shared by connections that back off (doc/design/extensions.md "MCP connections",
 * doc/design/channels.md "Channels"): 1 s doubling, with jitter, capped at 5 minutes. A successful connection
 * resets the attempt count the caller keeps.
 */

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/** The jitter band around a backoff delay: 80–120% of the exponential value. */
const JITTER_LOW = 0.8;
const JITTER_SPAN = 0.4;

/** The delay before attempt number `attempt` (1-based). */
export function backoffDelay(
	attempt: number,
	options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
	const base = options.baseMs ?? BACKOFF_BASE_MS;
	const max = options.maxMs ?? BACKOFF_MAX_MS;
	const exponential = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
	const random = options.random ?? Math.random;
	// Jitter is applied before the cap, so the actual delay never exceeds it.
	return Math.min(Math.round(exponential * (JITTER_LOW + random() * JITTER_SPAN)), max);
}

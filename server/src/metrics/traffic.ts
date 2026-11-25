/**
 * The traffic totals of one node (doc/design/metrics.md "Traffic totals"): the bytes received and
 * transmitted since the current period started, accumulated across reboots from the `net.rx_bytes` and
 * `net.tx_bytes` deltas the collector computes.
 *
 * A period is always exactly 30 days. crhs does no calendar or timezone math: the next reset is the
 * previous one plus the fixed period, so a period that was missed more than once rolls straight to the
 * period that contains the instant, and the server never deals in months or local time. The WebUI owns
 * every timezone conversion when it displays these instants.
 */

/** One period is exactly 30 days, whatever the calendar says. */
export const TRAFFIC_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** A node's traffic in its current period, as epoch milliseconds and bytes. */
export interface TrafficPeriod {
	periodStartMs: number;
	nextResetAtMs: number;
	rxBytes: number;
	txBytes: number;
}

/** A fresh period that starts at `atMs`, with no traffic yet. */
export function newTrafficPeriod(atMs: number): TrafficPeriod {
	return { periodStartMs: atMs, nextResetAtMs: atMs + TRAFFIC_PERIOD_MS, rxBytes: 0, txBytes: 0 };
}

/**
 * Rolls `period` forward while `atMs` is at or past its end: the totals become zero, the period starts at
 * the old end and ends one period later, repeated for every period that passed. A period whose stored
 * bounds are unusable is replaced rather than trusted, so one bad row cannot wedge a node's totals.
 */
export function rollTrafficPeriod(period: TrafficPeriod, atMs: number): TrafficPeriod {
	const start = period.periodStartMs;
	const next = period.nextResetAtMs;
	if (!Number.isFinite(start) || !Number.isFinite(next) || !(next > start)) return newTrafficPeriod(atMs);
	if (atMs < next) return period;
	// The same result as stepping one period at a time, in one step: k = 1 + floor((atMs - next) / period).
	const periods = Math.floor((atMs - next) / TRAFFIC_PERIOD_MS) + 1;
	return {
		periodStartMs: next + (periods - 1) * TRAFFIC_PERIOD_MS,
		nextResetAtMs: next + periods * TRAFFIC_PERIOD_MS,
		rxBytes: 0,
		txBytes: 0,
	};
}

/**
 * Whether `nextResetAtMs` may replace the current period's end: in the future and at most one period
 * away. A shorter period is allowed (the operator chooses it); a longer one would break the fixed 30-day
 * cycle the design promises.
 */
export function isValidTrafficNextReset(nextResetAtMs: number, nowMs: number): boolean {
	if (!Number.isFinite(nextResetAtMs)) return false;
	return nextResetAtMs > nowMs && nextResetAtMs <= nowMs + TRAFFIC_PERIOD_MS;
}

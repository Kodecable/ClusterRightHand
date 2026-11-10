/**
 * Formatting for the composer's generation line (doc/design/webui.md "Composer"):
 * the decode rate, the average TTFT and the tree's cache hit. Kept pure so
 * the rounding rules are unit-testable with an explicit locale.
 */

import { formatNumber } from "@/lib/format";

/**
 * A decode rate in tokens per second: an integer from 10 up, one decimal
 * below it. The session stores whole milliseconds and tokens, so the rate is
 * derived here rather than persisted.
 */
export function formatTokenRate(tokensPerSecond: number, locale: string): string {
	const rate = Number.isFinite(tokensPerSecond) && tokensPerSecond > 0 ? tokensPerSecond : 0;
	return formatNumber(rate, locale, { maximumFractionDigits: rate >= 10 ? 0 : 1 });
}

/** A latency: "1.2s" from a second up, whole milliseconds below it (e.g. "850ms"). */
export function formatLatency(ms: number, locale: string): string {
	const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
	if (value >= 1_000) return `${formatNumber(value / 1_000, locale, { maximumFractionDigits: 1 })}s`;
	return `${formatNumber(Math.round(value), locale)}ms`;
}

/**
 * The tree's cache hit as an integer percentage, or null when no prompt
 * tokens were recorded. It floors a non-exact ratio and never rounds up to
 * 100: only a read that covers the whole prompt shows 100.
 */
export function cacheHitPercent(cacheReadTokens: number, promptTokens: number): number | null {
	if (!(promptTokens > 0)) return null;
	if (cacheReadTokens === promptTokens) return 100;
	return Math.min(99, Math.floor((cacheReadTokens / promptTokens) * 100));
}

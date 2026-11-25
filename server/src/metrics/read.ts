/**
 * Shared reading rules for host metrics (doc/design/metrics.md "Reading"): input parsing, `prefix.*`
 * expansion and downsampling. The API route and the `node_metrics` tool both use them, so the two surfaces
 * accept the same patterns and bound the same work.
 */

/** At most this many series entries (names or patterns) one request may name. */
export const MAX_METRICS_SERIES = 64;

/** At most this many names a request's patterns may expand to, so `disk.*` cannot select unbounded series. */
export const MAX_EXPANDED_METRICS_SERIES = 512;

/** The longest range one read may ask for: 400 days, a little past level 4's default retention. */
export const MAX_METRICS_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

/** The most points the `node_metrics` tool describes per series; the API returns the stored buckets. */
export const MAX_METRICS_TOOL_POINTS = 60;

/** A bucket as the read surfaces use it; `t` is the bucket start in Unix epoch milliseconds. */
export interface MetricPoint {
	t: number;
	count: number;
	sum: number;
	min: number;
	max: number;
	last: number;
}

/** An instant from either the ISO or the epoch-millisecond form the API accepts; undefined when invalid. */
export function parseMetricsInstant(value: string): number | undefined {
	const text = value.trim();
	if (text === "") return undefined;
	if (/^-?\d+$/.test(text)) {
		const ms = Number(text);
		return Number.isSafeInteger(ms) ? ms : undefined;
	}
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? undefined : ms;
}

/** Splits a comma-separated `series` parameter, trimming entries and dropping empty ones. */
export function parseMetricsSeriesList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/**
 * The names the requested entries select: an explicit name is kept when the node has it, and `prefix.*`
 * keeps every existing name under `prefix.` (doc/design/metrics.md "Reading"). A pattern that matches
 * nothing, and an explicit name the node never had, are left out, so a node without that series simply
 * returns fewer series. Order follows the request, then the store's sorted names, and duplicates collapse.
 */
export function expandMetricsSeriesNames(available: readonly string[], requested: readonly string[]): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const entry of requested) {
		const matches = entry.endsWith(".*")
			? available.filter((name) => name.startsWith(entry.slice(0, -1)))
			: available.includes(entry)
				? [entry]
				: [];
		for (const name of matches) {
			if (seen.has(name)) continue;
			seen.add(name);
			names.push(name);
		}
	}
	return names;
}

/** A malformed series entry, as the API and the tool report it. */
export function invalidMetricsSeriesEntry(entry: string): string | undefined {
	if (entry === "") return "series entries must not be empty";
	if (entry.includes("*") && !entry.endsWith(".*")) return `series ${entry}: only a trailing .* pattern is supported`;
	if (entry.endsWith(".*") && entry.length === 2) return `series ${entry}: the prefix is empty`;
	return undefined;
}

/**
 * Merges adjacent buckets into at most `maxPoints` groups, keeping their order and combining each group
 * the same way the store does: `count`/`sum` add, `min`/`max` compare, `last` comes from the newest bucket
 * (doc/design/metrics.md "Reading"). A gap between stored buckets stays a gap: only stored buckets merge.
 */
export function mergeMetricPoints(points: readonly MetricPoint[], maxPoints: number): MetricPoint[] {
	if (points.length <= maxPoints || maxPoints <= 0) return [...points];
	const size = Math.ceil(points.length / maxPoints);
	const merged: MetricPoint[] = [];
	for (let index = 0; index < points.length; index += size) {
		const group = points.slice(index, index + size);
		const first = group[0];
		if (first === undefined) continue;
		let count = 0;
		let sum = 0;
		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		let last = first.last;
		for (const point of group) {
			count += point.count;
			sum += point.sum;
			if (point.min < min) min = point.min;
			if (point.max > max) max = point.max;
			last = point.last;
		}
		merged.push({ t: first.t, count, sum, min, max, last });
	}
	return merged;
}

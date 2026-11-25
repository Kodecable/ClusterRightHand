/**
 * `node_metrics` (doc/design/metrics.md "Reading" and doc/design/agent-runtime.md "Cluster tools"): the
 * stored metrics of one node over a fixed range, reduced to the minimum, average, maximum and last value
 * of every series and at most 60 points. It reads buckets, so like `node_info` it needs node access and no
 * rule decision.
 */
import { NODE_METRICS_RANGE_NAMES, NODE_METRICS_RANGES, type NodeMetricsRange } from "@crh/api";
import { listNodesForUser } from "../cluster/nodes.ts";
import { METRIC_LEVEL_BUCKET_MS } from "../metrics/levels.ts";
import {
	expandMetricsSeriesNames,
	invalidMetricsSeriesEntry,
	MAX_EXPANDED_METRICS_SERIES,
	MAX_METRICS_READ_POINTS,
	MAX_METRICS_SERIES,
	MAX_METRICS_TOOL_POINTS,
	type MetricPoint,
	mergeMetricPoints,
	metricsReadPoints,
} from "../metrics/read.ts";
import { UserError } from "../util/errors.ts";
import { formatBytes } from "../util/format.ts";
import { nameKey } from "../util/names.ts";
import type { ToolContext } from "./catalog.ts";
import { errorResult, jsonResult, type ToolResult } from "./render.ts";

/** The ranges `node_metrics` accepts, shared with the WebUI so the two tables cannot drift. */
export { NODE_METRICS_RANGE_NAMES, NODE_METRICS_RANGES, type NodeMetricsRange };

/** How a series' values are shown; the unit travels with the formatted numbers. */
type MetricUnit = "percent" | "bytes" | "bytes_per_sec" | "load" | "seconds" | "packets" | "number";

/** The series' unit (doc/design/metrics.md "Metrics"). */
function metricUnit(name: string): MetricUnit {
	if (name === "up" || name === "cpu.total" || name.startsWith("cpu.core.")) return "percent";
	if (name.startsWith("load.")) return "load";
	if (name.endsWith("_bytes_per_sec")) return "bytes_per_sec";
	if (name.endsWith("_bytes")) return "bytes";
	if (name.endsWith("_packets")) return "packets";
	if (name === "uptime") return "seconds";
	return "number";
}

/** One raw value in the series' unit: ratios become percentages, bytes become human-readable. */
function metricValue(name: string, value: number): string {
	switch (metricUnit(name)) {
		case "percent":
			return `${Number((value * 100).toFixed(1))}%`;
		case "bytes":
			return formatBytes(value);
		case "bytes_per_sec":
			return `${formatBytes(value)}/s`;
		case "load":
			return Number(value.toFixed(2)).toFixed(2);
		case "seconds":
			return `${Math.round(value)}s`;
		case "packets":
			return `${Math.round(value)} packets`;
		case "number":
			return String(Number(value.toFixed(3)));
	}
}

/** The store's buckets as read points, then merged down to the tool's point limit. */
function pointsOf(
	buckets: readonly { bucketStart: number; count: number; sum: number; min: number; max: number; last: number }[],
): MetricPoint[] {
	return mergeMetricPoints(
		buckets.map((bucket) => ({
			t: bucket.bucketStart,
			count: bucket.count,
			sum: bucket.sum,
			min: bucket.min,
			max: bucket.max,
			last: bucket.last,
		})),
		MAX_METRICS_TOOL_POINTS,
	);
}

/**
 * One series' summary: min, average, max and last over the range, the total for a delta, and the points.
 * A series with no bucket in the range keeps its last-seen time and no values.
 */
function seriesSummary(
	name: string,
	kind: "gauge" | "delta",
	lastSeenAt: string,
	buckets: readonly { bucketStart: number; count: number; sum: number; min: number; max: number; last: number }[],
	nowMs: number,
	bucketMs: number,
): Record<string, unknown> {
	const points = pointsOf(buckets);
	const unit = metricUnit(name);
	if (buckets.length === 0) {
		return {
			name,
			kind,
			unit,
			last_seen_at: lastSeenAt,
			stopped: true,
			note: "no samples in this range",
			points: [],
		};
	}
	let count = 0;
	let sum = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const bucket of buckets) {
		count += bucket.count;
		sum += bucket.sum;
		if (bucket.min < min) min = bucket.min;
		if (bucket.max > max) max = bucket.max;
	}
	const last = buckets[buckets.length - 1]?.last ?? 0;
	const newest = buckets[buckets.length - 1]?.bucketStart ?? 0;
	const average = count > 0 ? sum / count : 0;
	return {
		name,
		kind,
		unit,
		last_seen_at: lastSeenAt,
		stopped: nowMs - newest > 4 * bucketMs,
		min: metricValue(name, min),
		avg: metricValue(name, average),
		max: metricValue(name, max),
		last: metricValue(name, last),
		...(kind === "delta" ? { total: metricValue(name, sum) } : {}),
		points: points.map((point) => [point.t, metricValue(name, point.count > 0 ? point.sum / point.count : point.last)]),
	};
}

/** `node_metrics`: resolve the node, expand the series, read the range and summarize each series. */
export async function nodeMetricsResult(
	ctx: ToolContext,
	args: { node: string; series: readonly string[]; range: NodeMetricsRange },
): Promise<ToolResult> {
	const store = ctx.metrics;
	if (!store) return errorResult("json", "metrics_unavailable", "host metrics are not available on this server");
	if (args.series.length > MAX_METRICS_SERIES) {
		return errorResult("json", "invalid_argument", `series: at most ${MAX_METRICS_SERIES} entries are allowed`);
	}
	for (const entry of args.series) {
		const problem = invalidMetricsSeriesEntry(entry);
		if (problem !== undefined) return errorResult("json", "invalid_argument", problem);
	}
	const nodes = await listNodesForUser(ctx.db, ctx.user);
	const node = nodes.find((candidate) => candidate.id === args.node || nameKey(candidate.name) === nameKey(args.node));
	if (!node) throw new UserError(`no node ${args.node} that you can access`, "no_such_node");
	const available = await store.seriesNames(node.id);
	const names = expandMetricsSeriesNames(available, args.series);
	if (names.length === 0) {
		return errorResult("json", "no_series", `no series of ${node.name} match ${args.series.join(", ")}`);
	}
	if (names.length > MAX_EXPANDED_METRICS_SERIES) {
		return errorResult(
			"json",
			"invalid_argument",
			`series: the patterns name ${names.length} series, at most ${MAX_EXPANDED_METRICS_SERIES} are allowed`,
		);
	}
	const nowMs = Date.now();
	const fromMs = nowMs - NODE_METRICS_RANGES[args.range];
	// The same clock reading for the range and the level choice: a level must not fall to the next one only
	// because Date.now() moved between the two calls. The automatic choice also fits the read point cap.
	const level = store.chooseLevel(fromMs, nowMs, names.length, nowMs);
	const points = metricsReadPoints(names.length, fromMs, nowMs, level);
	if (points > MAX_METRICS_READ_POINTS) {
		return errorResult(
			"json",
			"invalid_argument",
			`series: the request needs ${points} points at level ${level}, at most ${MAX_METRICS_READ_POINTS} are allowed; choose a shorter range or fewer series`,
		);
	}
	const readings = await store.read(node.id, names, fromMs, nowMs, level);
	const bucketMs = METRIC_LEVEL_BUCKET_MS[level];
	// The traffic total is cumulative, so it is not a series in the range: it is reported once for the
	// node's current period (doc/design/metrics.md "Traffic totals").
	const traffic = await store.traffic(node.id, nowMs);
	return jsonResult({
		node: node.name,
		range: args.range,
		level,
		bucket_ms: bucketMs,
		from: new Date(fromMs).toISOString(),
		to: new Date(nowMs).toISOString(),
		point_limit: MAX_METRICS_TOOL_POINTS,
		points_format: "[bucket start (Unix epoch milliseconds), value]",
		traffic:
			traffic === undefined
				? null
				: {
						period_start: new Date(traffic.periodStartMs).toISOString(),
						next_reset_at: new Date(traffic.nextResetAtMs).toISOString(),
						rx_bytes: traffic.rxBytes,
						tx_bytes: traffic.txBytes,
					},
		series: readings.map((reading) =>
			seriesSummary(reading.name, reading.kind, reading.lastSeenAt, reading.buckets, nowMs, bucketMs),
		),
	});
}

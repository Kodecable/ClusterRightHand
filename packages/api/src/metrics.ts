/**
 * Runtime constants and pure helpers shared by the server and the WebUI for the node metrics and node
 * management surfaces (doc/design/metrics.md "Traffic totals" and "Reading", doc/design/webui.md "Node
 * pages"). They are values, not types, so both sides cannot drift: the fixed period, the range table, the
 * user remark rule and the first-filesystem choice live here once.
 */

/** The ranges the node page and the metrics API offer (doc/design/webui.md "Node pages"). */
export const NODE_METRICS_RANGE_NAMES = ["1h", "24h", "7d", "30d", "365d"] as const;

export type NodeMetricsRange = (typeof NODE_METRICS_RANGE_NAMES)[number];

/** Each range in milliseconds. */
export const NODE_METRICS_RANGES: Record<NodeMetricsRange, number> = {
	"1h": 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
	"365d": 365 * 24 * 60 * 60 * 1000,
};

/**
 * The series `GET /api/nodes/{id}/metrics` returns when the request names none (doc/design/metrics.md
 * "Reading"): a small overview of reachability, uptime, CPU, load, memory and the network rates. When a
 * filesystem is known, the route also asks for its `total_bytes` and `used_bytes` series, and those two
 * names sit between the memory and network entries.
 */
export const NODE_METRICS_DEFAULT_SERIES = [
	"up",
	"uptime",
	"cpu.total",
	"load.1",
	"mem.total_bytes",
	"mem.available_bytes",
	"net.rx_bytes_per_sec",
	"net.tx_bytes_per_sec",
] as const;

/** The bucket values a read may ask for with `fields`; `t` is always returned. */
export const NODE_METRICS_FIELDS = ["count", "avg", "sum", "min", "max", "last"] as const;

export type NodeMetricsField = (typeof NODE_METRICS_FIELDS)[number];

/** The units a series can have (doc/design/metrics.md "Metrics"); values stay raw numbers. */
export const METRIC_UNITS = ["ratio", "bytes", "bytes_per_sec", "load", "seconds", "packets", "count"] as const;

export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * A series' unit from its name (doc/design/metrics.md "Metrics"). Ratios stay 0–1, bytes counts and
 * rates are not formatted: the API promises values, not display strings.
 */
export function metricUnit(name: string): MetricUnit {
	if (name === "up" || name === "cpu.total" || name.startsWith("cpu.core.")) return "ratio";
	if (name.startsWith("load.")) return "load";
	if (name.endsWith("_bytes_per_sec")) return "bytes_per_sec";
	if (name.endsWith("_bytes")) return "bytes";
	if (name.endsWith("_packets")) return "packets";
	if (name === "uptime") return "seconds";
	return "count";
}

/** One traffic period is exactly 30 days, whatever the calendar says (doc/design/metrics.md "Traffic totals"). */
export const TRAFFIC_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether `nextResetAtMs` may replace the current traffic period's end: in the future and at most one
 * period away. A shorter period is allowed (the operator chooses it); a longer one would break the fixed
 * 30-day cycle the design promises.
 */
export function isValidTrafficNextReset(nextResetAtMs: number, nowMs: number): boolean {
	if (!Number.isFinite(nextResetAtMs)) return false;
	return nextResetAtMs > nowMs && nextResetAtMs <= nowMs + TRAFFIC_PERIOD_MS;
}

/** A node user remark's limit in Unicode code points (doc/design/data-model.md "Nodes"). */
export const NODE_USER_REMARK_MAX_CODE_POINTS = 50;

/**
 * Characters a user remark may not contain: control characters, the line and paragraph separators (which
 * a single-line input would otherwise hide), and the bidi controls that can reorder the surrounding text.
 */
const FORBIDDEN_USER_REMARK_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Why a trimmed, non-empty user remark is invalid, or undefined when it is accepted. The message is the
 * part after the server's `user remark: ` prefix, so both the API error and the WebUI's guard use the
 * same rule and wording (doc/design/data-model.md "Nodes").
 */
export function nodeUserRemarkProblem(userRemark: string): string | undefined {
	if (FORBIDDEN_USER_REMARK_CHARACTERS.test(userRemark)) {
		return "must be a single line without control characters";
	}
	if ([...userRemark].length > NODE_USER_REMARK_MAX_CODE_POINTS) {
		return `at most ${NODE_USER_REMARK_MAX_CODE_POINTS} characters are allowed`;
	}
	return undefined;
}

/**
 * The filesystem the summary card describes (doc/design/metrics.md "Reading"): the first name the
 * collector remembers reporting that is complete, else `root`, else the alphabetically first complete one.
 * A filesystem with only one of its two values cannot say how full it is, so the caller passes only the
 * complete names. Sorting by code unit keeps the choice identical on every runtime and locale.
 */
export function firstFilesystem(completeNames: Iterable<string>, diskOrder?: readonly string[]): string | undefined {
	const names = completeNames instanceof Set ? completeNames : new Set(completeNames);
	for (const name of diskOrder ?? []) if (names.has(name)) return name;
	if (names.has("root")) return "root";
	return [...names].sort()[0];
}

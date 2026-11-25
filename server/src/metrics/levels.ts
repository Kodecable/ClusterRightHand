/**
 * The storage levels of host metrics (doc/design/metrics.md "Storage"): every value is written into the
 * current bucket of each level its series is kept at, so a read picks the coarsest level that still gives a
 * useful number of points.
 */

/** The four levels, finest first. */
export const METRIC_LEVELS = [1, 2, 3, 4] as const;

export type MetricLevel = (typeof METRIC_LEVELS)[number];

/** The bucket width of each level, in milliseconds. */
export const METRIC_LEVEL_BUCKET_MS: Record<MetricLevel, number> = {
	1: 60 * 1000,
	2: 5 * 60 * 1000,
	3: 60 * 60 * 1000,
	4: 24 * 60 * 60 * 1000,
};

/** A read at a given level returns at least this many points over the range, when a level can satisfy it. */
export const METRIC_MIN_READ_POINTS = 200;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The default retention per level (doc/design/metrics.md "Storage"): 24 hours, 7 days, 30 days, 365 days. */
export const DEFAULT_METRICS_RETENTION_MS: MetricsRetentionConfig = {
	l1Ms: 24 * HOUR,
	l2Ms: 7 * DAY,
	l3Ms: 30 * DAY,
	l4Ms: 365 * DAY,
};

/** Per-level retention of metric buckets, in milliseconds, resolved from System settings. */
export interface MetricsRetentionConfig {
	l1Ms: number;
	l2Ms: number;
	l3Ms: number;
	l4Ms: number;
}

/** One level's retention. */
export function retentionMsForLevel(retention: MetricsRetentionConfig, level: MetricLevel): number {
	switch (level) {
		case 1:
			return retention.l1Ms;
		case 2:
			return retention.l2Ms;
		case 3:
			return retention.l3Ms;
		case 4:
			return retention.l4Ms;
	}
}

/** The start of the bucket of `level` that contains `slotStartMs`; bucket starts are aligned to the width. */
export function metricBucketStart(slotStartMs: number, level: MetricLevel): number {
	const size = METRIC_LEVEL_BUCKET_MS[level];
	return Math.floor(slotStartMs / size) * size;
}

/** The arguments of {@link chooseMetricsLevel}; all instants are Unix epoch milliseconds. */
export interface ChooseMetricsLevelOptions {
	fromMs: number;
	toMs: number;
	nowMs: number;
	retention: MetricsRetentionConfig;
}

/**
 * The level a read of `[fromMs, toMs)` uses when the caller names none (doc/design/metrics.md "Reading"):
 * the coarsest level whose retention covers `fromMs` and whose bucket gives at least
 * {@link METRIC_MIN_READ_POINTS} points, else the finest level whose retention covers `fromMs`, else the
 * coarsest level. Pure, so the choice is tested without a database.
 *
 * A caller computes `from` from its own clock a few milliseconds before crhs sees the request, so a range
 * exactly at a level's retention (24h, 7d, 30d, 365d) would otherwise fall to the next level. One bucket
 * of the candidate level is allowed as skew: the level's oldest bucket is still readable, and a range at
 * the boundary keeps its intended level. A longer overshoot still moves to the coarser level whose
 * retention covers the range.
 */
export function chooseMetricsLevel(options: ChooseMetricsLevelOptions): MetricLevel {
	const { fromMs, toMs, nowMs, retention } = options;
	const covered = (level: MetricLevel): boolean =>
		retentionMsForLevel(retention, level) + METRIC_LEVEL_BUCKET_MS[level] >= nowMs - fromMs;
	const points = (level: MetricLevel): number => (toMs - fromMs) / METRIC_LEVEL_BUCKET_MS[level];
	for (const level of [...METRIC_LEVELS].reverse()) {
		if (covered(level) && points(level) >= METRIC_MIN_READ_POINTS) return level;
	}
	for (const level of METRIC_LEVELS) {
		if (covered(level)) return level;
	}
	return 4;
}

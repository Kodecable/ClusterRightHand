import { describe, expect, it } from "vitest";
import {
	expandMetricsSeriesNames,
	fitMetricsReadLevel,
	MAX_METRICS_READ_POINTS,
	type MetricPoint,
	mergeMetricPoints,
	metricsReadPoints,
} from "../src/metrics/read.ts";

describe("expandMetricsSeriesNames", () => {
	it("expands prefix.* on the dot boundary, so disk.* does not select diskx.foo or disks", () => {
		const available = ["cpu.total", "disk.root.total_bytes", "disk.root.used_bytes", "disks", "diskx.foo", "up"];
		expect(expandMetricsSeriesNames(available, ["disk.*"])).toEqual(["disk.root.total_bytes", "disk.root.used_bytes"]);
	});
});

describe("mergeMetricPoints", () => {
	it("merges a group by adding count and sum, comparing min and max, and keeping the newest bucket's last", () => {
		const points: MetricPoint[] = [
			{ t: 0, count: 1, sum: 10, min: 10, max: 10, last: 10 },
			{ t: 60_000, count: 2, sum: 30, min: 5, max: 20, last: 20 },
			{ t: 120_000, count: 3, sum: 60, min: 1, max: 30, last: 30 },
			{ t: 180_000, count: 4, sum: 100, min: 2, max: 40, last: 40 },
		];
		expect(mergeMetricPoints(points, 2)).toEqual([
			{ t: 0, count: 3, sum: 40, min: 5, max: 20, last: 20 },
			{ t: 120_000, count: 7, sum: 160, min: 1, max: 40, last: 40 },
		]);
	});
});

describe("metrics read point cap", () => {
	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;
	const from = Date.UTC(2026, 5, 1, 12, 0);
	const at = (rangeMs: number) => from + rangeMs;

	it("counts every series' buckets over the range", () => {
		expect(metricsReadPoints(1, from, at(HOUR), 1)).toBe(60);
		expect(metricsReadPoints(2, from, at(HOUR), 1)).toBe(120);
		expect(metricsReadPoints(512, from, at(30 * DAY), 3)).toBe(512 * 720);
		expect(metricsReadPoints(512, from, at(30 * DAY), 4)).toBe(512 * 30);
		expect(MAX_METRICS_READ_POINTS).toBe(200_000);
	});

	it("moves a read to a coarser level only when the finer one would exceed the cap", () => {
		// 30 days of 512 series: level 3 gives 368,640 points; level 4 gives 15,360.
		expect(fitMetricsReadLevel(3, 512, from, at(30 * DAY))).toBe(4);
		// A normal read keeps its level.
		expect(fitMetricsReadLevel(3, 3, from, at(30 * DAY))).toBe(3);
		// Even the coarsest level is returned when nothing fits; the caller reports the over-cap error.
		expect(fitMetricsReadLevel(1, 512, from, at(400 * DAY))).toBe(4);
		expect(metricsReadPoints(512, from, at(400 * DAY), 4)).toBeGreaterThan(MAX_METRICS_READ_POINTS);
	});
});

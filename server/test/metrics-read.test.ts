import { describe, expect, it } from "vitest";
import { expandMetricsSeriesNames, type MetricPoint, mergeMetricPoints } from "../src/metrics/read.ts";

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

import { MAX_METRICS_CORES, type MetricsSnapshot } from "@crh/protocol";
import { describe, expect, it } from "vitest";
import { METRICS_COUNTER_PRUNE_AFTER_SAMPLES, MetricsComputer } from "../src/metrics/compute.ts";
import type { MetricValue } from "../src/metrics/store.ts";

/**
 * The computation rules of doc/design/metrics.md "Computation": counters are kept per node and per
 * counter identity, new counters only record their start, backwards counters restart, missing counters
 * keep their previous value, a new bootId clears everything, bigint counters are subtracted before
 * they become numbers, and a counter younger than half the sample interval yields no rate or ratio.
 */

const INTERVAL_MS = 1_000;

/** Samples with the normal interval, so every counter's span is measured against a known interval. */
function sampleAt(computer: MetricsComputer, nodeId: string, raw: MetricsSnapshot, atMs: number) {
	return computer.sample(nodeId, raw, atMs, INTERVAL_MS);
}

function metricValue(values: readonly MetricValue[], name: string): MetricValue | undefined {
	return values.find((value) => value.name === name);
}

function expectValue(
	values: readonly MetricValue[],
	name: string,
	expected: number,
	kind: "gauge" | "delta" = "gauge",
) {
	const value = metricValue(values, name);
	expect(value, `missing ${name}`).toBeDefined();
	expect(value?.kind).toBe(kind);
	expect(value?.value).toBeCloseTo(expected, 9);
}

function sample(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
	return { ...overrides };
}

function cpu(totalBusy: bigint, totalJiffies: bigint, cores: [number, bigint, bigint][] = []) {
	return {
		total: { busy: totalBusy, total: totalJiffies },
		cores: cores.map(([index, busy, total]) => ({ index, busy, total })),
	};
}

function interfaceCounters(name: string, rxBytes: bigint, txBytes: bigint, rxPackets: bigint, txPackets: bigint) {
	return { name, rxBytes, txBytes, rxPackets, txPackets };
}

const BASE: MetricsSnapshot = {
	bootId: "boot-a",
	uptimeSec: 120,
	cpu: cpu(100n, 200n, [
		[0, 50n, 100n],
		[1, 50n, 100n],
	]),
	loads: { l1: 1230, l5: 250, l15: 0 },
	memory: { totalBytes: 8000n, availableBytes: 4000n, cachedBytes: 2000n, freeBytes: 1000n },
	swap: { totalBytes: 2000n, freeBytes: 1500n },
	disks: [{ kind: "ok", name: "root", path: "/", totalBytes: 100_000n, usedBytes: 40_000n }],
	interfaces: [interfaceCounters("eth0", 10_000n, 20_000n, 100n, 200n)],
};

describe("metrics computation", () => {
	it("records every gauge of the first sample and no counter delta or rate", () => {
		const computer = new MetricsComputer();
		const result = sampleAt(computer, "node", BASE, 1_000);
		expect(result.rebooted).toBe(false);
		expect(result.bootId).toBe("boot-a");
		expectValue(result.values, "uptime", 120);
		expectValue(result.values, "load.1", 1.23);
		expectValue(result.values, "load.5", 0.25);
		expectValue(result.values, "load.15", 0);
		expectValue(result.values, "mem.total_bytes", 8000);
		expectValue(result.values, "mem.available_bytes", 4000);
		expectValue(result.values, "mem.cached_bytes", 2000);
		expectValue(result.values, "mem.free_bytes", 1000);
		expectValue(result.values, "swap.total_bytes", 2000);
		expectValue(result.values, "swap.free_bytes", 1500);
		expectValue(result.values, "disk.root.total_bytes", 100_000);
		expectValue(result.values, "disk.root.used_bytes", 40_000);
		expect(metricValue(result.values, "cpu.total")).toBeUndefined();
		expect(metricValue(result.values, "cpu.core.0")).toBeUndefined();
		expect(metricValue(result.values, "net.rx_bytes")).toBeUndefined();
		expect(metricValue(result.values, "net.rx_bytes_per_sec")).toBeUndefined();
	});

	it("computes CPU ratios, network deltas and rates from the two answers", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		const result = sampleAt(
			computer,
			"node",
			sample({
				...BASE,
				uptimeSec: 122,
				cpu: cpu(150n, 400n, [
					[0, 75n, 200n],
					[1, 75n, 200n],
				]),
				interfaces: [interfaceCounters("eth0", 11_000n, 22_000n, 110n, 220n)],
			}),
			3_000,
		);
		expectValue(result.values, "cpu.total", 0.25);
		expectValue(result.values, "cpu.core.0", 0.25);
		expectValue(result.values, "cpu.core.1", 0.25);
		expectValue(result.values, "net.rx_bytes", 1_000, "delta");
		expectValue(result.values, "net.tx_bytes", 2_000, "delta");
		expectValue(result.values, "net.rx_packets", 10, "delta");
		expectValue(result.values, "net.tx_packets", 20, "delta");
		expectValue(result.values, "net.rx_bytes_per_sec", 500);
		expectValue(result.values, "net.tx_bytes_per_sec", 1_000);
	});

	it("withholds a rate and its delta when the monotonic clock did not advance", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		const same = sampleAt(
			computer,
			"node",
			sample({ ...BASE, interfaces: [interfaceCounters("eth0", 12_000n, 22_000n, 110n, 220n)] }),
			1_000,
		);
		// Zero time is below the minimum span: no rate, and no delta either, because the counters and
		// their time are kept for the next sample.
		expect(metricValue(same.values, "net.rx_bytes")).toBeUndefined();
		expect(metricValue(same.values, "net.rx_bytes_per_sec")).toBeUndefined();
		const next = sampleAt(
			computer,
			"node",
			sample({ ...BASE, interfaces: [interfaceCounters("eth0", 13_000n, 22_000n, 110n, 220n)] }),
			2_000,
		);
		// The withheld 2,000 bytes and the new 1,000 are one delta over the second since the baseline.
		expectValue(next.values, "net.rx_bytes", 3_000, "delta");
		expectValue(next.values, "net.rx_bytes_per_sec", 3_000);
	});

	it("withholds rates and ratios until half the sample interval has passed", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		// 6 ms after the baseline: a rate here would divide 959 bytes by 0.006 s.
		const early = sampleAt(
			computer,
			"node",
			sample({
				...BASE,
				uptimeSec: 121,
				cpu: cpu(150n, 400n, [
					[0, 75n, 200n],
					[1, 75n, 200n],
				]),
				interfaces: [interfaceCounters("eth0", 10_959n, 20_000n, 110n, 200n)],
			}),
			1_006,
		);
		expect(metricValue(early.values, "cpu.total")).toBeUndefined();
		expect(metricValue(early.values, "cpu.core.0")).toBeUndefined();
		expect(metricValue(early.values, "net.rx_bytes")).toBeUndefined();
		expect(metricValue(early.values, "net.rx_bytes_per_sec")).toBeUndefined();
		expect(metricValue(early.values, "net.tx_bytes_per_sec")).toBeUndefined();

		const full = sampleAt(
			computer,
			"node",
			sample({
				...BASE,
				uptimeSec: 122,
				cpu: cpu(250n, 800n, [
					[0, 125n, 400n],
					[1, 125n, 400n],
				]),
				interfaces: [interfaceCounters("eth0", 12_000n, 22_000n, 120n, 220n)],
			}),
			2_000,
		);
		// The full-interval sample covers the whole span from the baseline: 2,000 bytes in 1 s, and
		// 150 busy of 600 total jiffies.
		expectValue(full.values, "net.rx_bytes", 2_000, "delta");
		expectValue(full.values, "net.tx_bytes", 2_000, "delta");
		expectValue(full.values, "net.rx_packets", 20, "delta");
		expectValue(full.values, "net.tx_packets", 20, "delta");
		expectValue(full.values, "net.rx_bytes_per_sec", 2_000);
		expectValue(full.values, "net.tx_bytes_per_sec", 2_000);
		expectValue(full.values, "cpu.total", 0.25);
		expectValue(full.values, "cpu.core.0", 0.25);
	});

	it("does not lose or double-count traffic across a withheld delta", () => {
		const computer = new MetricsComputer();
		const rxs = [10_000n, 10_959n, 11_000n, 12_000n];
		const times = [1_000, 1_006, 1_010, 2_000];
		const results = rxs.map((rx, index) =>
			sampleAt(
				computer,
				"node",
				sample({ ...BASE, interfaces: [interfaceCounters("eth0", rx, 20_000n, 100n, 200n)] }),
				times[index] as number,
			),
		);
		// Both skipped samples withheld their deltas with their rates...
		expect(metricValue(results[1]?.values ?? [], "net.rx_bytes")).toBeUndefined();
		expect(metricValue(results[2]?.values ?? [], "net.rx_bytes")).toBeUndefined();
		// ...so the only emitted delta is the exact counter difference since the baseline.
		const summed = results.reduce(
			(total, result) => total + (metricValue(result.values, "net.rx_bytes")?.value ?? 0),
			0,
		);
		expect(summed).toBe(Number((rxs[3] as bigint) - (rxs[0] as bigint)));
		expect(metricValue(results[3]?.values ?? [], "net.rx_bytes")?.value).toBe(2_000);
	});

	it("computes a CPU ratio over the whole span after a withheld ratio", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		const early = sampleAt(computer, "node", sample({ ...BASE, cpu: cpu(105n, 210n, [[0, 55n, 110n]]) }), 1_006);
		// The early ratio would have been 5/10 = 0.5, from a handful of jiffies.
		expect(metricValue(early.values, "cpu.total")).toBeUndefined();
		expect(metricValue(early.values, "cpu.core.0")).toBeUndefined();
		const full = sampleAt(computer, "node", sample({ ...BASE, cpu: cpu(250n, 800n, [[0, 125n, 400n]]) }), 2_000);
		// 150 busy of 600 total jiffies since the baseline, not 145 of 590 since the skipped sample.
		expectValue(full.values, "cpu.total", 0.25);
		expectValue(full.values, "cpu.core.0", 0.25);
	});

	it("keeps each interface's span independent when one appears late", () => {
		const computer = new MetricsComputer();
		sampleAt(
			computer,
			"node",
			sample({ bootId: "b", interfaces: [interfaceCounters("eth0", 1_000n, 2_000n, 10n, 20n)] }),
			0,
		);
		const early = sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				interfaces: [
					interfaceCounters("eth0", 2_000n, 3_000n, 20n, 30n),
					interfaceCounters("eth1", 500n, 600n, 5n, 6n),
				],
			}),
			6,
		);
		// eth0's span is too short; eth1 only records its start. Neither produces a value.
		expect(metricValue(early.values, "net.rx_bytes")).toBeUndefined();
		expect(metricValue(early.values, "net.rx_bytes_per_sec")).toBeUndefined();

		const full = sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				interfaces: [
					interfaceCounters("eth0", 3_000n, 5_000n, 30n, 50n),
					interfaceCounters("eth1", 1_500n, 1_600n, 15n, 16n),
				],
			}),
			1_000,
		);
		// eth0: 2,000 B since t=0 over 1 s, unaffected by eth1 appearing at t=6 ms.
		// eth1: 1,000 B since its own counters at t=6 ms, over 0.994 s.
		expectValue(full.values, "net.rx_bytes", 3_000, "delta");
		expectValue(full.values, "net.rx_bytes_per_sec", 2_000 + 1_000 / 0.994);
	});

	it("records only the start of a new core and a new interface", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		const result = sampleAt(
			computer,
			"node",
			sample({
				...BASE,
				cpu: cpu(110n, 220n, [
					[0, 55n, 110n],
					[1, 55n, 110n],
					[2, 5n, 10n],
				]),
				interfaces: [
					interfaceCounters("eth0", 10_500n, 20_000n, 100n, 200n),
					interfaceCounters("eth1", 777n, 888n, 7n, 8n),
				],
			}),
			2_000,
		);
		expectValue(result.values, "cpu.core.0", 0.5);
		expect(metricValue(result.values, "cpu.core.2")).toBeUndefined();
		// eth0's delta is counted; eth1's whole history is not one sample's traffic.
		expectValue(result.values, "net.rx_bytes", 500, "delta");
		expectValue(result.values, "net.tx_bytes", 0, "delta");
	});

	it("does not produce network values when every interface is new", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", sample({ bootId: "b", interfaces: [] }), 1_000);
		const result = sampleAt(
			computer,
			"node",
			sample({ bootId: "b", interfaces: [interfaceCounters("eth0", 999n, 999n, 9n, 9n)] }),
			2_000,
		);
		expect(metricValue(result.values, "net.rx_bytes")).toBeUndefined();
		expect(metricValue(result.values, "net.rx_bytes_per_sec")).toBeUndefined();
	});

	it("restarts a counter that went backwards without a negative delta", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		const first = sample({
			...BASE,
			interfaces: [
				interfaceCounters("eth0", 10_000n, 20_000n, 100n, 200n),
				interfaceCounters("eth1", 100n, 100n, 10n, 10n),
			],
		});
		sampleAt(computer, "node", first, 1_000);
		const result = sampleAt(
			computer,
			"node",
			sample({
				...BASE,
				cpu: cpu(10n, 20n, [[0, 5n, 10n]]),
				interfaces: [
					// eth0's rx went backwards: it restarts and contributes no delta at all.
					interfaceCounters("eth0", 5n, 20_000n, 100n, 200n),
					// eth1 did not advance, which is a valid zero delta.
					interfaceCounters("eth1", 100n, 100n, 10n, 10n),
				],
			}),
			2_000,
		);
		// The cpu line and core 0 fell: restarts, no value.
		expect(metricValue(result.values, "cpu.total")).toBeUndefined();
		expect(metricValue(result.values, "cpu.core.0")).toBeUndefined();
		expectValue(result.values, "net.rx_bytes", 0, "delta");
		expectValue(result.values, "net.tx_bytes", 0, "delta");
		expect(metricValue(result.values, "net.rx_bytes")?.value).toBeGreaterThanOrEqual(0);
	});

	it("keeps a missing counter's previous value for the next sample that has it", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		// No cpu and no interfaces: their previous values stay.
		sampleAt(computer, "node", sample({ bootId: "boot-a", uptimeSec: 121 }), 2_000);
		const result = sampleAt(
			computer,
			"node",
			sample({
				...BASE,
				cpu: cpu(130n, 300n, [[0, 65n, 150n]]),
				interfaces: [interfaceCounters("eth0", 11_000n, 22_000n, 110n, 220n)],
			}),
			4_000,
		);
		expectValue(result.values, "cpu.total", 0.3);
		expectValue(result.values, "cpu.core.0", 0.3);
		// The delta is from the first sample's counter, and the rate divides it by the 3 s since that
		// counter was stored, not by one interval.
		expectValue(result.values, "net.rx_bytes", 1_000, "delta");
		expectValue(result.values, "net.rx_bytes_per_sec", 1_000 / 3);
		expectValue(result.values, "net.tx_bytes_per_sec", 2_000 / 3);
	});

	it("divides a rate by the whole gap when a sample has no interfaces field", () => {
		const computer = new MetricsComputer();
		sampleAt(
			computer,
			"node",
			sample({ bootId: "b", interfaces: [interfaceCounters("eth0", 10_000n, 20_000n, 100n, 200n)] }),
			0,
		);
		// The interfaces field is absent: eth0's counters and their time stay for the next sample.
		sampleAt(computer, "node", sample({ bootId: "b", uptimeSec: 60 }), 60_000);
		const result = sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				uptimeSec: 120,
				interfaces: [interfaceCounters("eth0", 16_000n, 23_000n, 130n, 230n)],
			}),
			120_000,
		);
		// The delta spans both intervals, so the rate divides it by 120 s rather than by 60 s.
		expectValue(result.values, "net.rx_bytes", 6_000, "delta");
		expectValue(result.values, "net.tx_bytes", 3_000, "delta");
		expectValue(result.values, "net.rx_bytes_per_sec", 50);
		expectValue(result.values, "net.tx_bytes_per_sec", 25);
	});

	it("sums each interface's rate over the time since its own counters", () => {
		const computer = new MetricsComputer();
		sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				interfaces: [interfaceCounters("eth0", 0n, 0n, 0n, 0n), interfaceCounters("eth1", 0n, 0n, 0n, 0n)],
			}),
			0,
		);
		// eth1 is missing: eth0 advances and updates its time, eth1 keeps its counters and their time.
		sampleAt(
			computer,
			"node",
			sample({ bootId: "b", interfaces: [interfaceCounters("eth0", 6_000n, 12_000n, 60n, 120n)] }),
			60_000,
		);
		const result = sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				interfaces: [
					interfaceCounters("eth0", 9_000n, 18_000n, 90n, 180n),
					interfaceCounters("eth1", 3_000n, 6_000n, 30n, 60n),
				],
			}),
			120_000,
		);
		// eth0: 3_000 B in 60 s; eth1: 3_000 B in 120 s. The rates sum each interface's own rate,
		// while the delta series sum the raw deltas.
		expectValue(result.values, "net.rx_bytes", 6_000, "delta");
		expectValue(result.values, "net.rx_bytes_per_sec", 75);
		expectValue(result.values, "net.tx_bytes", 12_000, "delta");
		expectValue(result.values, "net.tx_bytes_per_sec", 150);
	});

	it("clears every previous value on a new bootId", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		const rebooted = sampleAt(
			computer,
			"node",
			sample({
				bootId: "boot-b",
				cpu: cpu(1n, 2n, [[0, 1n, 2n]]),
				interfaces: [interfaceCounters("eth0", 1n, 2n, 3n, 4n)],
			}),
			2_000,
		);
		expect(rebooted.rebooted).toBe(true);
		expect(rebooted.bootId).toBe("boot-b");
		expect(metricValue(rebooted.values, "cpu.total")).toBeUndefined();
		expect(metricValue(rebooted.values, "cpu.core.0")).toBeUndefined();
		expect(metricValue(rebooted.values, "net.rx_bytes")).toBeUndefined();
		// The new boot's counters are the start for the next sample.
		const next = sampleAt(
			computer,
			"node",
			sample({
				bootId: "boot-b",
				cpu: cpu(3n, 6n, [[0, 3n, 6n]]),
				interfaces: [interfaceCounters("eth0", 11n, 12n, 13n, 14n)],
			}),
			3_000,
		);
		expectValue(next.values, "cpu.total", 0.5);
		expectValue(next.values, "net.rx_bytes", 10, "delta");
	});

	it("omits cpu.total when the line did not advance or went backwards", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", sample({ bootId: "b", cpu: cpu(100n, 200n) }), 1_000);
		const unchanged = sampleAt(computer, "node", sample({ bootId: "b", cpu: cpu(100n, 200n) }), 2_000);
		expect(metricValue(unchanged.values, "cpu.total")).toBeUndefined();
		const backwards = sampleAt(computer, "node", sample({ bootId: "b", cpu: cpu(90n, 190n) }), 3_000);
		expect(metricValue(backwards.values, "cpu.total")).toBeUndefined();
	});

	it("sums each interface's own delta after a reset", () => {
		const computer = new MetricsComputer();
		sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				interfaces: [interfaceCounters("a", 100n, 100n, 10n, 10n), interfaceCounters("b", 100n, 100n, 10n, 10n)],
			}),
			1_000,
		);
		const result = sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				interfaces: [
					// "a" restarted and contributes nothing; "b" advanced normally.
					interfaceCounters("a", 1n, 1n, 1n, 1n),
					interfaceCounters("b", 150n, 170n, 15n, 17n),
				],
			}),
			2_000,
		);
		expectValue(result.values, "net.rx_bytes", 50, "delta");
		expectValue(result.values, "net.tx_bytes", 70, "delta");
		expectValue(result.values, "net.rx_packets", 5, "delta");
		expectValue(result.values, "net.tx_packets", 7, "delta");
	});

	it("produces no values for a sample with no fields", () => {
		const computer = new MetricsComputer();
		expect(sampleAt(computer, "node", {}, 1_000).values).toEqual([]);
	});

	it("subtracts bigint counters exactly above 2^53", () => {
		const computer = new MetricsComputer();
		const big = 2n ** 53n + 1n;
		sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				cpu: cpu(big / 2n, big),
				interfaces: [interfaceCounters("eth0", big, big, big, big)],
			}),
			1_000,
		);
		const result = sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				cpu: cpu(big / 2n + 100n, big + 200n),
				interfaces: [interfaceCounters("eth0", big + 100n, big + 200n, big + 10n, big + 20n)],
			}),
			2_000,
		);
		// Converting first would round these differences to 0 or 100 depending on the value.
		expectValue(result.values, "cpu.total", 0.5);
		expectValue(result.values, "net.rx_bytes", 100, "delta");
		expectValue(result.values, "net.tx_bytes", 200, "delta");
		expectValue(result.values, "net.rx_packets", 10, "delta");
		expectValue(result.values, "net.tx_packets", 20, "delta");
	});

	it("enforces the per-sample limits defensively", () => {
		const computer = new MetricsComputer();
		const cores: [number, bigint, bigint][] = [];
		for (let i = 0; i < 1025; i++) cores.push([i, 1n, 2n]);
		const disks = Array.from({ length: 65 }, (_, i) => ({
			kind: "ok" as const,
			name: `d${i}`,
			path: "/",
			totalBytes: 1n,
			usedBytes: 0n,
		}));
		const interfaces = Array.from({ length: 257 }, (_, i) => interfaceCounters(`i${i}`, 1n, 1n, 1n, 1n));
		sampleAt(computer, "node", sample({ bootId: "b", cpu: cpu(1n, 1n, cores), disks, interfaces }), 1_000);
		const result = sampleAt(
			computer,
			"node",
			sample({
				bootId: "b",
				cpu: cpu(
					2n,
					2n,
					cores.map(([index, busy, total]) => [index, busy + 1n, total + 2n]),
				),
				disks: disks.map((disk) => ({ ...disk, totalBytes: 2n, usedBytes: 1n })),
				interfaces: interfaces.map((iface) => ({
					...iface,
					rxBytes: iface.rxBytes + 1n,
					txBytes: iface.txBytes + 1n,
					rxPackets: iface.rxPackets + 1n,
					txPackets: iface.txPackets + 1n,
				})),
			}),
			2_000,
		);
		expect(metricValue(result.values, "cpu.core.1023")).toBeDefined();
		expect(metricValue(result.values, "cpu.core.1024")).toBeUndefined();
		expect(metricValue(result.values, "disk.d63.total_bytes")).toBeDefined();
		expect(metricValue(result.values, "disk.d64.total_bytes")).toBeUndefined();
		expectValue(result.values, "net.rx_bytes", 256, "delta");
	});

	it("drops a core and an interface that stay absent for the prune limit", () => {
		expect(METRICS_COUNTER_PRUNE_AFTER_SAMPLES).toBe(10);
		const absent = sample({ bootId: "boot-a", cpu: cpu(100n, 200n, []), interfaces: [] });
		const returning = sample({
			...BASE,
			cpu: cpu(150n, 400n, [[0, 75n, 200n]]),
			interfaces: [interfaceCounters("eth0", 11_000n, 22_000n, 110n, 220n)],
		});

		// One sample short of the limit: the previous counters are still there, so a delta is computed.
		const kept = new MetricsComputer();
		sampleAt(kept, "node", BASE, 1_000);
		for (let index = 1; index < 10; index++) {
			sampleAt(kept, "node", absent, 1_000 + index * 1_000);
		}
		const stillThere = sampleAt(kept, "node", returning, 20_000);
		expectValue(stillThere.values, "cpu.core.0", 0.25);
		expectValue(stillThere.values, "net.rx_bytes", 1_000, "delta");

		// At the limit the state is gone: the same sample only records the counters' starting values.
		const pruned = new MetricsComputer();
		sampleAt(pruned, "node", BASE, 1_000);
		for (let index = 0; index < 10; index++) {
			sampleAt(pruned, "node", absent, 1_000 + index * 1_000);
		}
		const fresh = sampleAt(pruned, "node", returning, 20_000);
		expect(metricValue(fresh.values, "cpu.core.0")).toBeUndefined();
		expect(metricValue(fresh.values, "net.rx_bytes")).toBeUndefined();
	});

	it("sums interfaces whose Linux names the old character form dropped", () => {
		const computer = new MetricsComputer();
		// Names Linux allows that the old `[A-Za-z0-9_.:@-]` form dropped: `+`, `#`, `~` and non-ASCII.
		const names = ["wg+0", "网卡0", "eth0#1", "a~b"];
		sampleAt(
			computer,
			"node",
			sample({ ...BASE, interfaces: names.map((name) => interfaceCounters(name, 0n, 0n, 0n, 0n)) }),
			1_000,
		);
		const result = sampleAt(
			computer,
			"node",
			sample({ ...BASE, interfaces: names.map((name) => interfaceCounters(name, 100n, 200n, 1n, 2n)) }),
			2_000,
		);
		// Every interface is summed into the same net.* series; no interface name is a series name.
		expectValue(result.values, "net.rx_bytes", 400, "delta");
		expectValue(result.values, "net.tx_bytes", 800, "delta");
		expectValue(result.values, "net.rx_packets", 4, "delta");
		expectValue(result.values, "net.tx_packets", 8, "delta");
		expectValue(result.values, "net.rx_bytes_per_sec", 400);
		expectValue(result.values, "net.tx_bytes_per_sec", 800);
	});

	it("drops a raw sample's out-of-form disk, interface and core names", () => {
		const computer = new MetricsComputer();
		sampleAt(
			computer,
			"node",
			sample({
				...BASE,
				cpu: cpu(100n, 200n, [[MAX_METRICS_CORES, 1n, 2n]]),
				disks: [{ kind: "ok", name: "bad name", path: "/", totalBytes: 1n, usedBytes: 1n }],
				interfaces: [
					interfaceCounters("bad name", 1n, 1n, 1n, 1n),
					interfaceCounters("a/b", 1n, 1n, 1n, 1n),
					interfaceCounters("a".repeat(16), 1n, 1n, 1n, 1n),
					interfaceCounters("a\u0007b", 1n, 1n, 1n, 1n),
					interfaceCounters("eth0", 10_000n, 0n, 0n, 0n),
				],
			}),
			1_000,
		);
		const result = sampleAt(
			computer,
			"node",
			sample({
				...BASE,
				cpu: cpu(150n, 400n, [
					[MAX_METRICS_CORES, 100n, 200n],
					[0, 75n, 200n],
				]),
				disks: [{ kind: "ok", name: "bad name", path: "/", totalBytes: 2n, usedBytes: 2n }],
				interfaces: [
					interfaceCounters("bad name", 1_000_000n, 1_000_000n, 1n, 1n),
					interfaceCounters("a/b", 1_000_000n, 1_000_000n, 1n, 1n),
					interfaceCounters("a".repeat(16), 1_000_000n, 1_000_000n, 1n, 1n),
					interfaceCounters("a\u0007b", 1_000_000n, 1_000_000n, 1n, 1n),
					interfaceCounters("eth0", 11_000n, 0n, 0n, 0n),
				],
			}),
			3_000,
		);
		// The invalid disk never becomes a series, and the invalid interface's counters are not a delta.
		expect(result.values.some((value) => value.name.includes("bad name"))).toBe(false);
		expect(metricValue(result.values, `cpu.core.${MAX_METRICS_CORES}`)).toBeUndefined();
		expectValue(result.values, "net.rx_bytes", 1_000, "delta");
	});

	it("forgets a node when asked", () => {
		const computer = new MetricsComputer();
		sampleAt(computer, "node", BASE, 1_000);
		computer.forget("node");
		const result = sampleAt(computer, "node", sample({ ...BASE, uptimeSec: 1 }), 2_000);
		expect(metricValue(result.values, "cpu.total")).toBeUndefined();
		expect(metricValue(result.values, "net.rx_bytes")).toBeUndefined();
	});
});

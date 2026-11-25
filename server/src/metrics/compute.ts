/**
 * The computation of stored host metrics from one raw sample (doc/design/metrics.md "Computation").
 * crhs keeps, per node, the previous raw value of every counter by its own identity: the `cpu` line,
 * each core by index and each interface by name. Every rate and delta comes from one counter's own
 * previous value, so a new core or interface only records its start, a counter that went backwards
 * restarts, and a missing counter keeps its previous value for the next sample that has it. A new
 * bootId clears everything: boot counters restart at boot.
 *
 * This module is pure: it does no I/O and never looks at a clock. The caller passes the raw sample, the
 * monotonic time of its answer and the configured sample interval; a network rate divides an interface's
 * delta by the time since that interface's own counters were stored, so a sample missing the interface
 * keeps both until it returns. A counter younger than half the interval yields no rate or ratio and keeps
 * its stored value, so a baseline followed within milliseconds by a slot sample cannot produce a spike:
 * the next sample computes over the whole span (doc/design/metrics.md "Computation").
 */
import {
	isValidMetricsCoreIndex,
	isValidMetricsDiskName,
	isValidMetricsInterfaceName,
	MAX_METRICS_CORES,
	MAX_METRICS_DISKS,
	MAX_METRICS_INTERFACES,
	type MetricsSnapshot,
} from "@crh/protocol";
import type { MetricValue } from "./store.ts";

/** How many consecutive samples a core or interface may be absent before its counters are forgotten. */
export const METRICS_COUNTER_PRUNE_AFTER_SAMPLES = 10;

/** One CPU line's jiffies, as /proc/stat reports them, and when they were stored. */
interface CPUCounter {
	busy: bigint;
	total: bigint;
	/** The monotonic answer time of the sample that stored these counters, for this line's ratio span. */
	atMs: number;
	/** Consecutive samples that did not report this core; it is dropped at the limit. */
	missingSamples?: number;
}

/** One interface's counters, as /proc/net/dev reports them, and when they were stored. */
interface InterfaceCounter {
	rxBytes: bigint;
	txBytes: bigint;
	rxPackets: bigint;
	txPackets: bigint;
	/** The monotonic answer time of the sample that stored these counters, for this interface's rate. */
	atMs: number;
	/** Consecutive samples that did not report this interface; it is dropped at the limit. */
	missingSamples: number;
}

/** What one node's previous sample left behind between calls. */
interface NodeCounters {
	bootId?: string;
	cpu?: CPUCounter;
	cores: Map<number, CPUCounter>;
	interfaces: Map<string, InterfaceCounter>;
}

/** One computed sample: the values to store and what the caller needs to know about the boot. */
export interface ComputedSample {
	values: MetricValue[];
	/** The bootId of the sample, or of the previous sample when this one could not report it. */
	bootId: string | undefined;
	/** The sample named a bootId different from the previous one, so all counters restarted. */
	rebooted: boolean;
}

/**
 * A node's previous counters and the computation of its next sample (doc/design/metrics.md
 * "Computation"). One instance holds every node's state; the caller drops a node with {@link forget}.
 */
export class MetricsComputer {
	readonly #nodes = new Map<string, NodeCounters>();

	/**
	 * Records one raw sample for a node and returns the values it produces. The sample must be the
	 * decoded `metrics.collect` body or the parsed SSH script output; `answerMonotonicMs` is the
	 * monotonic time its answer was received, used for rate and ratio spans. `intervalMs` is the
	 * configured sample interval: a counter younger than half of it yields no rate or ratio and keeps
	 * its stored value, so the next sample computes over the whole span.
	 */
	sample(nodeId: string, raw: MetricsSnapshot, answerMonotonicMs: number, intervalMs: number): ComputedSample {
		let state = this.#nodes.get(nodeId);
		if (state === undefined) {
			state = { cores: new Map(), interfaces: new Map() };
			this.#nodes.set(nodeId, state);
		}
		let rebooted = false;
		// A new boot clears every previous value: counters restart at boot
		// (doc/design/metrics.md "Computation").
		if (raw.bootId !== undefined && state.bootId !== undefined && raw.bootId !== state.bootId) {
			rebooted = true;
			state = { bootId: raw.bootId, cores: new Map(), interfaces: new Map() };
			this.#nodes.set(nodeId, state);
		} else if (raw.bootId !== undefined) {
			state.bootId = raw.bootId;
		}

		const values: MetricValue[] = [];
		const pushGauge = (name: string, value: number): void => {
			if (Number.isFinite(value)) values.push({ name, kind: "gauge", value });
		};
		// A rate or ratio must span a meaningful interval. Half the sample interval keeps normal
		// sequences unchanged while a baseline followed immediately by a slot sample is withheld
		// (doc/design/metrics.md "Computation").
		const minSpanMs = intervalMs > 0 && Number.isFinite(intervalMs) ? intervalMs / 2 : 0;

		if (raw.uptimeSec !== undefined) pushGauge("uptime", raw.uptimeSec);
		computeCPU(state, raw, answerMonotonicMs, minSpanMs, values);
		if (raw.loads !== undefined) {
			pushGauge("load.1", raw.loads.l1 / 1000);
			pushGauge("load.5", raw.loads.l5 / 1000);
			pushGauge("load.15", raw.loads.l15 / 1000);
		}
		if (raw.memory !== undefined) {
			pushGauge("mem.total_bytes", Number(raw.memory.totalBytes));
			pushGauge("mem.available_bytes", Number(raw.memory.availableBytes));
			pushGauge("mem.cached_bytes", Number(raw.memory.cachedBytes));
			pushGauge("mem.free_bytes", Number(raw.memory.freeBytes));
		}
		if (raw.swap !== undefined) {
			pushGauge("swap.total_bytes", Number(raw.swap.totalBytes));
			pushGauge("swap.free_bytes", Number(raw.swap.freeBytes));
		}
		if (raw.disks !== undefined) {
			// The limits of one sample (doc/design/metrics.md "Limits"); a decoded body is already bounded,
			// but the computation enforces them too so no caller can grow a node's series past them.
			for (const disk of raw.disks.slice(0, MAX_METRICS_DISKS)) {
				// A name outside the protocol's form is dropped here too, so a caller that did not go through
				// the decoded message cannot turn it into a series (doc/design/metrics.md "Limits").
				if (disk.kind !== "ok" || !isValidMetricsDiskName(disk.name)) continue;
				const total = Number(disk.totalBytes);
				const used = Number(disk.usedBytes);
				pushGauge(`disk.${disk.name}.total_bytes`, total);
				pushGauge(`disk.${disk.name}.used_bytes`, used);
			}
		}
		computeNetwork(state, raw, answerMonotonicMs, minSpanMs, values);

		return { values, bootId: state.bootId, rebooted };
	}

	/** Drops a node's previous counters, e.g. after the node was deleted. */
	forget(nodeId: string): void {
		this.#nodes.delete(nodeId);
	}
}

function computeCPU(
	state: NodeCounters,
	raw: MetricsSnapshot,
	answerMonotonicMs: number,
	minSpanMs: number,
	values: MetricValue[],
): void {
	const cpu = raw.cpu;
	if (cpu === undefined) return;
	const previous = state.cpu;
	if (previous === undefined) {
		state.cpu = { busy: cpu.total.busy, total: cpu.total.total, atMs: answerMonotonicMs };
	} else if (cpu.total.total < previous.total || cpu.total.busy < previous.busy) {
		// A line that fell is a restart: it starts again at this value, exactly as before.
		state.cpu = { busy: cpu.total.busy, total: cpu.total.total, atMs: answerMonotonicMs };
	} else if (!(minSpanMs > 0 && answerMonotonicMs - previous.atMs < minSpanMs)) {
		const deltaTotal = cpu.total.total - previous.total;
		const deltaBusy = cpu.total.busy - previous.busy;
		// A line that did not advance has no ratio.
		if (deltaTotal > 0n) {
			const value = ratio(deltaBusy, deltaTotal);
			if (Number.isFinite(value)) values.push({ name: "cpu.total", kind: "gauge", value });
		}
		state.cpu = { busy: cpu.total.busy, total: cpu.total.total, atMs: answerMonotonicMs };
	}
	// The else branch keeps the previous counters and their time: the sample arrived before half an
	// interval passed, so the next one computes the ratio over the whole span.

	const present = new Set<number>();
	for (const core of cpu.cores.slice(0, MAX_METRICS_CORES)) {
		if (!isValidMetricsCoreIndex(core.index)) continue;
		present.add(core.index);
		const old = state.cores.get(core.index);
		if (old === undefined) {
			state.cores.set(core.index, {
				busy: core.busy,
				total: core.total,
				atMs: answerMonotonicMs,
				missingSamples: 0,
			});
			continue;
		}
		if (core.total < old.total || core.busy < old.busy) {
			// A core that fell restarted: its new value is the start, with no ratio.
			state.cores.set(core.index, {
				busy: core.busy,
				total: core.total,
				atMs: answerMonotonicMs,
				missingSamples: 0,
			});
			continue;
		}
		if (minSpanMs > 0 && answerMonotonicMs - old.atMs < minSpanMs) {
			// Too soon for a ratio: keep this core's counters and their time for the next sample.
			old.missingSamples = 0;
			continue;
		}
		const deltaTotal = core.total - old.total;
		const deltaBusy = core.busy - old.busy;
		if (deltaTotal > 0n) {
			const value = ratio(deltaBusy, deltaTotal);
			if (Number.isFinite(value)) {
				values.push({ name: `cpu.core.${core.index}`, kind: "gauge", value });
			}
		}
		state.cores.set(core.index, {
			busy: core.busy,
			total: core.total,
			atMs: answerMonotonicMs,
			missingSamples: 0,
		});
	}
	// A core that stays offline would otherwise keep its counters in memory forever, and a node whose core
	// count changes could grow the map sample after sample (doc/design/metrics.md "Computation").
	for (const [index, counter] of state.cores) {
		if (present.has(index)) continue;
		counter.missingSamples = (counter.missingSamples ?? 0) + 1;
		if (counter.missingSamples >= METRICS_COUNTER_PRUNE_AFTER_SAMPLES) state.cores.delete(index);
	}
}

function computeNetwork(
	state: NodeCounters,
	raw: MetricsSnapshot,
	answerMonotonicMs: number,
	minSpanMs: number,
	values: MetricValue[],
): void {
	const interfaces = raw.interfaces;
	if (interfaces === undefined) return;
	let rxBytes = 0n;
	let txBytes = 0n;
	let rxPackets = 0n;
	let txPackets = 0n;
	// An interface that was not in the previous sample only records its start: its whole history is
	// not one sample's traffic (doc/design/metrics.md "Computation").
	let deltas = false;
	// Each interface's rate divides its own delta by the time since its own counters were stored, and
	// the node's rates sum those; a sample that lacked an interface left both its counters and its time
	// for the next sample that has it, so its delta and its divisor cover the same span.
	let rxRate = 0;
	let txRate = 0;
	let rates = false;
	const present = new Set<string>();
	for (const iface of interfaces.slice(0, MAX_METRICS_INTERFACES)) {
		if (!isValidMetricsInterfaceName(iface.name)) continue;
		present.add(iface.name);
		const old = state.interfaces.get(iface.name);
		if (old === undefined) {
			state.interfaces.set(iface.name, {
				rxBytes: iface.rxBytes,
				txBytes: iface.txBytes,
				rxPackets: iface.rxPackets,
				txPackets: iface.txPackets,
				atMs: answerMonotonicMs,
				missingSamples: 0,
			});
			continue;
		}
		if (
			iface.rxBytes < old.rxBytes ||
			iface.txBytes < old.txBytes ||
			iface.rxPackets < old.rxPackets ||
			iface.txPackets < old.txPackets
		) {
			// A counter that went backwards is a restart: only its new start is recorded, with no delta.
			state.interfaces.set(iface.name, {
				rxBytes: iface.rxBytes,
				txBytes: iface.txBytes,
				rxPackets: iface.rxPackets,
				txPackets: iface.txPackets,
				atMs: answerMonotonicMs,
				missingSamples: 0,
			});
			continue;
		}
		if (minSpanMs > 0 && answerMonotonicMs - old.atMs < minSpanMs) {
			// Too soon for a rate. The interface's delta is withheld with it, because its counters and
			// their time are kept: the next sample's delta covers both spans and no traffic is lost.
			old.missingSamples = 0;
			continue;
		}
		const deltaRx = iface.rxBytes - old.rxBytes;
		const deltaTx = iface.txBytes - old.txBytes;
		rxBytes += deltaRx;
		txBytes += deltaTx;
		rxPackets += iface.rxPackets - old.rxPackets;
		txPackets += iface.txPackets - old.txPackets;
		deltas = true;
		// Rates divide by the time between the two answers on crhs's monotonic clock; a clock that
		// did not move (or moved backwards) gives no rate rather than a division by zero or a
		// negative one, though the interface's delta still counts.
		const seconds = (answerMonotonicMs - old.atMs) / 1000;
		if (seconds > 0 && Number.isFinite(seconds)) {
			rxRate += Number(deltaRx) / seconds;
			txRate += Number(deltaTx) / seconds;
			rates = true;
		}
		state.interfaces.set(iface.name, {
			rxBytes: iface.rxBytes,
			txBytes: iface.txBytes,
			rxPackets: iface.rxPackets,
			txPackets: iface.txPackets,
			atMs: answerMonotonicMs,
			missingSamples: 0,
		});
	}
	for (const [name, counter] of state.interfaces) {
		if (present.has(name)) continue;
		counter.missingSamples += 1;
		if (counter.missingSamples >= METRICS_COUNTER_PRUNE_AFTER_SAMPLES) state.interfaces.delete(name);
	}
	if (!deltas) return;
	if (rates) {
		if (Number.isFinite(rxRate)) values.push({ name: "net.rx_bytes_per_sec", kind: "gauge", value: rxRate });
		if (Number.isFinite(txRate)) values.push({ name: "net.tx_bytes_per_sec", kind: "gauge", value: txRate });
	}
	values.push({ name: "net.rx_bytes", kind: "delta", value: Number(rxBytes) });
	values.push({ name: "net.tx_bytes", kind: "delta", value: Number(txBytes) });
	values.push({ name: "net.rx_packets", kind: "delta", value: Number(rxPackets) });
	values.push({ name: "net.tx_packets", kind: "delta", value: Number(txPackets) });
}

/** Δbusy / Δtotal as a ratio 0–1; a malformed line cannot produce a value outside the series' range. */
function ratio(busy: bigint, total: bigint): number {
	const value = Number(busy) / Number(total);
	if (!Number.isFinite(value)) return Number.NaN;
	return Math.min(1, Math.max(0, value));
}

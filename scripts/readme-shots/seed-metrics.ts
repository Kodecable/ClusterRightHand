// Seeds the throwaway README cluster's metrics history (scripts/readme-shots/README.md): crhs has just
// recorded a couple of real samples, so this opens the same SQLite database with the server's storage layer
// and records one synthetic minute for every minute before the first real one. Stopped crhs first, started
// it again afterwards: everything older than the first real slot is synthetic, everything newer is real.
//
// usage: node scripts/readme-shots/seed-metrics.ts /data/crhs.db [minutes]
import { parseArgs } from "node:util";
import { MetricsStore, type MetricValue } from "../../server/src/metrics/store.ts";
import { openDb } from "../../server/src/storage/db.ts";
import { migrateToLatest } from "../../server/src/storage/migrate.ts";

const MINUTE_MS = 60_000;
const DEFAULT_MINUTES = 65;
const DEFAULT_CPU_BASE = 0.12;
/** How fast a synthetic filesystem fills: a tiny fraction of its used bytes per minute. */
const DISK_GROWTH_PER_MINUTE = 0.00002;

type MetricKind = "gauge" | "delta";

interface RealSeries {
	kind: MetricKind;
	value: number;
}

/** One node's real latest sample, plus the first slot it has a real bucket in. */
interface RealHistory {
	id: string;
	name: string;
	earliestSlot: number;
	latestSlot: number;
	series: Map<string, RealSeries>;
}

/** The fixed values and smoothed starting points of one node's synthetic history. */
interface NodeProfile {
	names: ReadonlySet<string>;
	cpuBase: number;
	coreCount: number;
	memory:
		| {
				total: number;
				usedFraction: number;
				cachedFraction: number;
				freeFraction: number;
		  }
		| undefined;
	load: { l1: number; l5: number; l15: number };
	swap: { total: number; freeFraction: number } | undefined;
	disks: { name: string; total: number; used: number }[];
	rxBase: number;
	txBase: number;
	seed: number;
}

const { values, positionals } = parseArgs({
	options: {
		minutes: { type: "string", default: String(DEFAULT_MINUTES) },
	},
	allowPositionals: true,
});
const dbPath = positionals[0];
if (dbPath === undefined) throw new Error("usage: node scripts/readme-shots/seed-metrics.ts <sqlite path> [minutes]");
const minutes = Number(positionals[1] ?? values.minutes);
if (!Number.isSafeInteger(minutes) || minutes <= 0) throw new Error(`invalid minutes: ${values.minutes}`);

const db = openDb({ driver: "sqlite", path: dbPath });
try {
	await migrateToLatest(db);
	const histories = await readHistories(db);
	if (histories.length === 0) throw new Error("no node has a real metrics sample to seed from");
	const store = new MetricsStore(db, { timer: false });
	for (const history of histories) seedNode(store, history, minutes);
	await store.flush();
} finally {
	await db.destroy();
}

async function readHistories(db: ReturnType<typeof openDb>): Promise<RealHistory[]> {
	const nodes = await db
		.selectFrom("nodes")
		.select(["id", "name"])
		.where("status", "=", "active")
		.orderBy("name")
		.execute();
	const seriesRows = await db.selectFrom("metric_series").select(["id", "node_id", "name", "kind"]).execute();
	const bucketRows = await db
		.selectFrom("metric_buckets")
		.select(["series_id", "bucket_start", "last"])
		.where("level", "=", 1)
		.execute();

	const seriesByNode = new Map<string, Map<string, { id: string; kind: MetricKind }>>();
	for (const row of seriesRows) {
		let series = seriesByNode.get(row.node_id);
		if (series === undefined) {
			series = new Map();
			seriesByNode.set(row.node_id, series);
		}
		series.set(row.name, { id: row.id, kind: row.kind });
	}
	const bucketsBySeries = new Map<string, { start: number; last: number }[]>();
	for (const row of bucketRows) {
		let list = bucketsBySeries.get(row.series_id);
		if (list === undefined) {
			list = [];
			bucketsBySeries.set(row.series_id, list);
		}
		list.push({ start: Number(row.bucket_start), last: Number(row.last) });
	}

	const histories: RealHistory[] = [];
	for (const node of nodes) {
		const series = seriesByNode.get(node.id);
		if (series === undefined) continue;
		const real = new Map<string, RealSeries>();
		let earliestSlot = Number.POSITIVE_INFINITY;
		let latestSlot = Number.NEGATIVE_INFINITY;
		for (const [name, meta] of series) {
			const buckets = bucketsBySeries.get(meta.id) ?? [];
			if (buckets.length === 0) continue;
			let newest = buckets[0] as { start: number; last: number };
			for (const bucket of buckets) {
				if (bucket.start > newest.start) newest = bucket;
				if (bucket.start < earliestSlot) earliestSlot = bucket.start;
				if (bucket.start > latestSlot) latestSlot = bucket.start;
			}
			real.set(name, { kind: meta.kind, value: Number(newest.last) });
		}
		if (real.size === 0) continue;
		histories.push({ id: node.id, name: node.name, earliestSlot, latestSlot, series: real });
	}
	return histories;
}

function seedNode(store: MetricsStore, history: RealHistory, count: number): void {
	const profile = profileOf(history);
	// Only strictly older slots: the first real minute already has samples and may not be written into.
	const lastSlot = history.earliestSlot - MINUTE_MS;
	const firstSlot = lastSlot - (count - 1) * MINUTE_MS;
	for (const sample of synthesize(history, profile, firstSlot, count)) {
		store.record(history.id, sample.slot, sample.values);
	}
	console.log(
		`${history.name}: ${count} synthetic minutes ${new Date(firstSlot).toISOString()} .. ${new Date(
			lastSlot,
		).toISOString()} (real from ${new Date(history.earliestSlot).toISOString()})`,
	);
}

/** Reads the latest real value of one series, or undefined when the sample did not have it. */
function realValue(history: RealHistory, name: string): number | undefined {
	const series = history.series.get(name);
	return series !== undefined && Number.isFinite(series.value) ? series.value : undefined;
}

function profileOf(history: RealHistory): NodeProfile {
	const names = new Set(history.series.keys());
	const realCpu = realValue(history, "cpu.total");
	const cpuBase =
		Math.min(0.35, Math.max(0.06, realCpu ?? DEFAULT_CPU_BASE)) + ((hashOf(history.name) >>> 8) % 80) / 1000;
	const coreCount = [...names].filter((name) => /^cpu\.core\.\d+$/.test(name)).length;

	const memTotal = realValue(history, "mem.total_bytes");
	const memAvailable = realValue(history, "mem.available_bytes");
	const memCached = realValue(history, "mem.cached_bytes");
	const memFree = realValue(history, "mem.free_bytes");
	const memory =
		memTotal !== undefined &&
		memTotal > 0 &&
		memAvailable !== undefined &&
		memCached !== undefined &&
		memFree !== undefined
			? {
					total: memTotal,
					usedFraction: clamp(1 - memAvailable / memTotal, 0.05, 0.95),
					cachedFraction: clamp(memCached / memTotal, 0.02, 0.75),
					freeFraction: clamp(memFree / memTotal, 0.01, 0.6),
				}
			: undefined;

	const swapTotal = realValue(history, "swap.total_bytes");
	const swapFree = realValue(history, "swap.free_bytes");
	const realLoad1 = realValue(history, "load.1");
	const realLoad5 = realValue(history, "load.5");
	const realLoad15 = realValue(history, "load.15");
	const load = {
		l1: realLoad1 ?? 0.1 + cpuBase * Math.max(coreCount, 1),
		l5: realLoad5 ?? realLoad1 ?? 0.1 + cpuBase * Math.max(coreCount, 1),
		l15: realLoad15 ?? realLoad5 ?? realLoad1 ?? 0.1 + cpuBase * Math.max(coreCount, 1),
	};

	const swap =
		swapTotal !== undefined && swapTotal > 0 && swapFree !== undefined
			? {
					total: swapTotal,
					// An unused swap stays nearly unused, but a little drift keeps the line from being flat.
					freeFraction: clamp(swapFree / swapTotal, 0.01, 1),
				}
			: undefined;

	const disksByName = new Map<string, { total?: number; used?: number }>();
	for (const name of names) {
		const match = /^disk\.(.+)\.(total_bytes|used_bytes)$/.exec(name);
		if (match === null) continue;
		const diskName = match[1] as string;
		const field = match[2] as "total_bytes" | "used_bytes";
		const entry = disksByName.get(diskName) ?? {};
		entry[field === "total_bytes" ? "total" : "used"] = realValue(history, name);
		disksByName.set(diskName, entry);
	}
	const disks = [...disksByName.entries()].flatMap(([name, entry]) =>
		entry.total !== undefined && entry.used !== undefined ? [{ name, total: entry.total, used: entry.used }] : [],
	);

	// The real latest rate is not a usable baseline: a freshly enrolled, idle node measures a few hundred
	// bytes per second, while a sample taken while the cluster starts up can reach hundreds of KiB/s. Seed a
	// busy database server instead: a few tens of KiB/s in each direction, varied a little by the node name
	// so two nodes do not draw the same line.
	const hash = hashOf(history.name);
	const rxBase = 40_000 + (hash % 12) * 1024;
	const txBase = 26_000 + ((hash >>> 8) % 10) * 1024;

	return { names, cpuBase, coreCount, memory, load, swap, disks, rxBase, txBase, seed: hash };
}

/**
 * One sample per minute, oldest first. Values are deterministic from the node name; the smoothed series
 * follow each other (load follows CPU, the memory lines drift together) and end just before the real data.
 * The network is a steady baseline with three bursts, all far enough from both ends that the seeded hour
 * starts and ends on the baseline.
 */
function synthesize(
	history: RealHistory,
	profile: NodeProfile,
	firstSlot: number,
	count: number,
): { slot: number; values: MetricValue[] }[] {
	const rng = mulberry32(profile.seed);
	const phase = (profile.seed % 1000) / 159;
	const realUptime = realValue(history, "uptime");
	const spikeA = count * 0.26;
	const spikeB = count * 0.64;
	const burstAt = [count * 0.2, count * 0.52, count * 0.8] as const;
	const samples: { slot: number; values: MetricValue[] }[] = [];

	let cpuNoise = 0;
	let memNoise = 0;
	let netNoise = 0;
	let load1 = profile.load.l1;
	let load5 = profile.load.l5;
	let load15 = profile.load.l15;

	for (let index = 0; index < count; index++) {
		const slot = firstSlot + index * MINUTE_MS;
		const values: MetricValue[] = [];
		const push = (name: string, kind: MetricKind, value: number): void => {
			if (!profile.names.has(name) || !Number.isFinite(value)) return;
			values.push({ name, kind, value });
		};

		push("up", "gauge", 1);
		if (realUptime !== undefined) {
			push("uptime", "gauge", Math.max(0, Math.round(realUptime - (history.latestSlot - slot) / 1000)));
		}

		cpuNoise = cpuNoise * 0.62 + (rng() * 2 - 1) * 0.028;
		const spike =
			0.34 * Math.exp(-((index - spikeA) ** 2) / (2 * 1.5 ** 2)) +
			0.19 * Math.exp(-((index - spikeB) ** 2) / (2 * 2.1 ** 2));
		const cpu = clamp(profile.cpuBase + 0.045 * Math.sin(index / 6.5 + phase) + cpuNoise + spike, 0.01, 0.95);
		push("cpu.total", "gauge", round(cpu, 4));
		for (let core = 0; core < profile.coreCount; core++) {
			const coreValue = clamp(cpu + (rng() * 2 - 1) * 0.035 + 0.012 * Math.sin(index / 3.1 + core), 0, 1);
			push(`cpu.core.${core}`, "gauge", round(coreValue, 4));
		}

		const loadTarget =
			profile.load.l1 + (cpu - profile.cpuBase) * Math.max(profile.coreCount, 1) * 0.55 + (rng() * 2 - 1) * 0.03;
		load1 = load1 * 0.6 + loadTarget * 0.4;
		load5 = load5 * 0.8 + loadTarget * 0.2;
		load15 = load15 * 0.9 + loadTarget * 0.1;
		push("load.1", "gauge", round(Math.max(0, load1), 3));
		push("load.5", "gauge", round(Math.max(0, load5), 3));
		push("load.15", "gauge", round(Math.max(0, load15), 3));

		if (profile.memory !== undefined) {
			const { total } = profile.memory;
			memNoise = memNoise * 0.85 + (rng() * 2 - 1) * 0.006;
			const usedFraction = clamp(
				profile.memory.usedFraction + 0.025 * Math.sin(index / 10 + phase) + memNoise,
				0.08,
				0.92,
			);
			const available = total * (1 - usedFraction);
			// Cached pages count as available, so the cached line may sit above the available line; it only
			// drifts, and the free line stays inside available.
			const cached =
				total * clamp(profile.memory.cachedFraction + 0.015 * Math.sin(index / 13 + phase * 1.7), 0.02, 0.72);
			const free =
				total *
				clamp(
					profile.memory.freeFraction + 0.006 * Math.sin(index / 9 + phase),
					0.005,
					Math.min(0.4, available / total),
				);
			push("mem.total_bytes", "gauge", total);
			push("mem.available_bytes", "gauge", Math.round(available));
			push("mem.cached_bytes", "gauge", Math.round(cached));
			push("mem.free_bytes", "gauge", Math.round(free));
		}

		if (profile.swap !== undefined) {
			const { total } = profile.swap;
			const unused = profile.swap.freeFraction >= 0.999;
			const freeFraction = clamp(
				(unused ? 0.972 : profile.swap.freeFraction) + 0.012 * Math.sin(index / 15 + phase),
				0,
				1,
			);
			push("swap.total_bytes", "gauge", total);
			push("swap.free_bytes", "gauge", Math.round(total * freeFraction));
		}

		for (const disk of profile.disks) {
			const grown = (disk.used * DISK_GROWTH_PER_MINUTE * (history.latestSlot - slot)) / MINUTE_MS;
			push(`disk.${disk.name}.total_bytes`, "gauge", disk.total);
			push(`disk.${disk.name}.used_bytes`, "gauge", Math.max(0, Math.round(disk.used - grown)));
		}

		// A slow wobble and a small random walk keep the baseline alive; three Gaussian bursts (two shared,
		// the last one send-heavy like a database flushing results) reach roughly 150–300 KiB/s on top of it.
		netNoise = netNoise * 0.72 + (rng() * 2 - 1) * 2200;
		const netWave = 1 + 0.11 * Math.sin(index / 7.1 + phase) + 0.05 * Math.sin(index / 19.7 + phase * 2);
		const rxRate = Math.max(
			0,
			Math.round(
				profile.rxBase * netWave +
					netNoise +
					145_000 * bump(index, burstAt[0], 1.8) +
					115_000 * bump(index, burstAt[1], 2.2) +
					130_000 * bump(index, burstAt[2], 2.4),
			),
		);
		const txRate = Math.max(
			0,
			Math.round(
				profile.txBase * netWave +
					netNoise * 0.3 +
					130_000 * bump(index, burstAt[0], 1.8) +
					130_000 * bump(index, burstAt[1], 2.2) +
					210_000 * bump(index, burstAt[2], 2.4),
			),
		);
		push("net.rx_bytes_per_sec", "gauge", rxRate);
		push("net.tx_bytes_per_sec", "gauge", txRate);
		push("net.rx_bytes", "delta", rxRate * 60);
		push("net.tx_bytes", "delta", txRate * 60);
		push("net.rx_packets", "delta", Math.max(1, Math.round((rxRate * 60) / 1100)));
		push("net.tx_packets", "delta", Math.max(1, Math.round((txRate * 60) / 1200)));

		samples.push({ slot, values });
	}
	return samples;
}

/** A Gaussian bump centred on a fraction of the seeded window; it is negligible at the window's edges. */
function bump(index: number, center: number, width: number): number {
	return Math.exp(-((index - center) ** 2) / (2 * width ** 2));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/** FNV-1a over the node name, then mulberry32: stable across runs and machines. */
function hashOf(text: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

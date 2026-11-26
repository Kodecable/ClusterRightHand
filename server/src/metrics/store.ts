import { MAX_METRICS_CORES, MAX_METRICS_DISKS } from "@crh/protocol";
import { type SqlBool, sql, type Transaction } from "kysely";
import type { Db } from "../storage/db.ts";
import type { Database } from "../storage/schema.ts";
import { errorText } from "../util/errors.ts";
import { newId } from "../util/id.ts";
import {
	chooseMetricsLevel,
	DEFAULT_METRICS_RETENTION_MS,
	METRIC_LEVELS,
	type MetricLevel,
	type MetricsRetentionConfig,
	metricBucketStart,
} from "./levels.ts";
import { fitMetricsReadLevel } from "./read.ts";
import {
	type MetricsRetentionSweepOptions,
	type MetricsRetentionSweepResult,
	sweepMetricRetention,
} from "./retention.ts";
import { newTrafficPeriod, rollTrafficPeriod, type TrafficPeriod } from "./traffic.ts";

/** How a series' values combine over a bucket (doc/design/metrics.md "Metrics"). */
export type MetricKind = "gauge" | "delta";

/** One sampled value: the series it belongs to and the value of this sample. */
export interface MetricValue {
	name: string;
	kind: MetricKind;
	value: number;
}

/** One stored bucket of a series. `bucketStart` is aligned to the level's width. */
export interface MetricBucket {
	bucketStart: number;
	count: number;
	sum: number;
	min: number;
	max: number;
	last: number;
}

/** A series' stored buckets in the requested range, with its kind and last-seen time. */
export interface MetricSeriesReading {
	name: string;
	kind: MetricKind;
	lastSeenAt: string;
	buckets: MetricBucket[];
}

export interface MetricsStoreOptions {
	/** Wall clock; tests replace it so level choice and retention are deterministic. */
	now?: () => number;
	/** How often the buffered samples are written; the design fixes five seconds. */
	flushIntervalMs?: number;
	/** The current per-level retention, read when a level must be chosen or a sweep runs. */
	retention?: () => MetricsRetentionConfig;
	/** Whether to start the flush timer; tests that flush explicitly pass false. */
	timer?: boolean;
}

export interface MetricsSweepResult {
	buckets: number;
	series: number;
}

/** A node's current traffic period with its node id (doc/design/metrics.md "Traffic totals"). */
export interface NodeTraffic extends TrafficPeriod {
	nodeId: string;
}

/** Values recorded but not written yet; one record() call or part of a slot's sample. */
interface BufferedSample {
	nodeId: string;
	slotStartMs: number;
	values: MetricValue[];
	/** How many flushes this sample has failed in; the second failure drops it. */
	failedFlushes: number;
}

interface SeriesCacheEntry {
	id: string;
	nodeId: string;
	name: string;
	kind: MetricKind;
	/** Epoch milliseconds of the stored `last_seen_at`. */
	lastSeenMs: number;
}

/** One buffered slot's network deltas, as the traffic totals accumulate them. */
interface TrafficDelta {
	slotStartMs: number;
	rxBytes: number;
	txBytes: number;
}

/** A selected `node_traffic` row; the table's own shape, kept apart from the computed period. */
interface TrafficRow {
	node_id: string;
	period_start: string;
	next_reset_at: string;
	rx_bytes: number;
	tx_bytes: number;
}

interface BucketAggregate {
	level: MetricLevel;
	bucketStart: number;
	count: number;
	sum: number;
	min: number;
	max: number;
	last: number;
	/** The slot whose value is currently `last`; a retroactive write must not move it backwards. */
	lastSlotMs: number;
}

interface SeriesAggregate {
	nodeId: string;
	name: string;
	kind: MetricKind;
	/** The earliest slot this flush holds for the series; a new row's `first_seen_at`. */
	firstSlotMs: number;
	/** The latest slot this flush holds for the series; a new row's `last_seen_at`. */
	lastSlotMs: number;
	buckets: BucketAggregate[];
}

/** One row of a batched `metric_buckets` upsert; `MetricBucketsTable` has the same shape. */
interface BucketRow {
	series_id: string;
	level: MetricLevel;
	bucket_start: number;
	count: number;
	sum: number;
	min: number;
	max: number;
	last: number;
}

/** A selected `metric_series` row, used to fill the id cache in one query per chunk. */
interface SeriesRow {
	id: string;
	node_id: string;
	name: string;
	kind: MetricKind;
	last_seen_at: string;
}

/** The default flush period of doc/design/metrics.md "Storage". */
export const METRICS_FLUSH_INTERVAL_MS = 5 * 1000;

/**
 * The most distinct series one node may have (doc/design/metrics.md "Limits"): every core, both values of
 * every filesystem, and the 18 fixed names the computation produces (`up`, `uptime`, `cpu.total`, the three
 * loads, the four memory values, swap, the four network deltas and the two rates). Past it, values of new
 * names are dropped while the node's existing series keep recording.
 */
export const MAX_METRICS_SERIES_PER_NODE = MAX_METRICS_CORES + MAX_METRICS_DISKS * 2 + 18;

/** How often a node's over-cap drop is logged: once per hour, not once per sample. */
const SERIES_CAP_LOG_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The most values buffered between flushes (doc/design/metrics.md "Storage"): a database that stays unavailable
 * for a while must not grow the buffer without bound, so the oldest samples are dropped past it.
 */
export const METRICS_MAX_PENDING_VALUES = 200_000;

/**
 * Rows or `(node_id, name)` pairs per flush statement, so a statement stays under SQLite's 32,766 bound
 * parameters (and PostgreSQL's 65,535): 500 bucket rows are 4,000 values.
 */
const FLUSH_CHUNK_SIZE = 500;

/**
 * The host metrics store (doc/design/metrics.md "Storage"): samples are buffered and written in one
 * transaction every five seconds and once more at shutdown, so a crash loses at most those seconds.
 *
 * A value is written into the current bucket of every level its series is kept at, with one upsert per
 * level: `count` and `sum` add, `min`/`max` compare, `last` is replaced. There is no rollup job, so every
 * level is current as soon as a sample is written. Series ids are cached in memory and created on first
 * use; `last_seen_at` is written at most once per level-2 bucket per series.
 *
 * The same flush adds each sample's network deltas to the node's traffic totals
 * (doc/design/metrics.md "Traffic totals"), and a node's period is rolled lazily when it is read or
 * changed, so a node with no new traffic still shows the right period.
 */
export class MetricsStore {
	readonly #db: Db;
	readonly #now: () => number;
	readonly #retention: () => MetricsRetentionConfig;
	readonly #flushIntervalMs: number;
	/** Buffered samples, oldest first; entries before `#pendingStart` were dropped at the cap. */
	#pending: BufferedSample[] = [];
	#pendingStart = 0;
	/** Number of values in the live part of `#pending`, kept in step so the cap check does not walk it. */
	#pendingValues = 0;
	/** Values dropped past the cap since the last flush; logged once at that flush. */
	#overflowDropped = 0;
	/** Serializes flushes and traffic mutations, so two statements never write the same row at once. */
	#chain: Promise<void> = Promise.resolve();
	/** Series id by `nodeId\0name`, resolved lazily and dropped when retention removes the series. */
	#seriesCache = new Map<string, SeriesCacheEntry>();
	/** Every series name a node has, for the per-node cap; loaded from the database on first use. */
	#seriesNames = new Map<string, Set<string>>();
	/** When each node's over-cap drop was last logged, so a busy node cannot flood the log. */
	#seriesCapLoggedAt = new Map<string, number>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(db: Db, options: MetricsStoreOptions = {}) {
		this.#db = db;
		this.#now = options.now ?? Date.now;
		this.#retention = options.retention ?? (() => DEFAULT_METRICS_RETENTION_MS);
		this.#flushIntervalMs = options.flushIntervalMs ?? METRICS_FLUSH_INTERVAL_MS;
		if (options.timer !== false) {
			this.#timer = setInterval(() => {
				void this.flush().catch((err: unknown) => console.error("metrics: flush failed:", err));
			}, this.#flushIntervalMs);
			// A timer alone must not keep the process alive.
			this.#timer.unref();
		}
	}

	/**
	 * Buffers one slot's values. `slotStartMs` is the slot's start on crhs's clock, so a past slot writes
	 * into the buckets it belongs to, including an earlier level-3 or level-4 bucket. Nothing is written
	 * until {@link flush}.
	 */
	record(nodeId: string, slotStartMs: number, values: readonly MetricValue[]): void {
		if (this.#closed) throw new Error("metrics store is closed");
		if (values.length === 0) return;
		const copied = values.map((value) => ({ name: value.name, kind: value.kind, value: value.value }));
		this.#pending.push({ nodeId, slotStartMs, values: copied, failedFlushes: 0 });
		this.#pendingValues += copied.length;
		this.#trimPending();
	}

	/** Writes everything buffered so far in one transaction. */
	flush(): Promise<void> {
		return this.#exclusive(() => this.#flushOnce());
	}

	/**
	 * Runs `work` after every earlier flush and traffic mutation settled. A failure does not block the
	 * next caller: the chain keeps only the settled signal, and each caller gets its own result.
	 */
	#exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(work);
		this.#chain = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/**
	 * Flushes once more and stops the timer. A second call waits for the same close.
	 */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		this.#closePromise = this.flush();
		return this.#closePromise;
	}

	/**
	 * Reads the stored buckets of the named series in `[fromMs, toMs)`. Without a level, the coarsest level
	 * whose retention covers `fromMs` and gives at least 200 points is used (doc/design/metrics.md "Reading");
	 * {@link chooseMetricsLevel} owns that choice.
	 */
	async read(
		nodeId: string,
		seriesNames: readonly string[],
		fromMs: number,
		toMs: number,
		level?: MetricLevel,
	): Promise<MetricSeriesReading[]> {
		const names = [...new Set(seriesNames)];
		if (names.length === 0) return [];
		const chosen = level ?? this.chooseLevel(fromMs, toMs);
		const seriesRows = await this.#db
			.selectFrom("metric_series")
			.select(["id", "name", "kind", "last_seen_at"])
			.where("node_id", "=", nodeId)
			.where("name", "in", names)
			.execute();
		if (seriesRows.length === 0) return [];
		const buckets = await this.#db
			.selectFrom("metric_buckets")
			.select(["series_id", "bucket_start", "count", "sum", "min", "max", "last"])
			.where(
				"series_id",
				"in",
				seriesRows.map((row) => row.id),
			)
			.where("level", "=", chosen)
			.where("bucket_start", ">=", metricBucketStart(fromMs, chosen))
			.where("bucket_start", "<", toMs)
			.orderBy("bucket_start")
			.execute();
		const bySeries = new Map<string, MetricBucket[]>();
		for (const row of buckets) {
			const list = bySeries.get(row.series_id) ?? [];
			list.push({
				bucketStart: Number(row.bucket_start),
				count: Number(row.count),
				sum: Number(row.sum),
				min: Number(row.min),
				max: Number(row.max),
				last: Number(row.last),
			});
			bySeries.set(row.series_id, list);
		}
		const byName = new Map(seriesRows.map((row) => [row.name, row]));
		// The caller's order, with a series that exists but has no bucket in the range kept with an empty list:
		// the WebUI draws a stopped series up to its last value.
		return names.flatMap((name) => {
			const row = byName.get(name);
			if (!row) return [];
			return [
				{
					name,
					kind: row.kind,
					lastSeenAt: row.last_seen_at,
					buckets: bySeries.get(row.id) ?? [],
				},
			];
		});
	}

	/**
	 * The names of the node's stored series, sorted, for `prefix.*` expansion in the read API
	 * (doc/design/metrics.md "Reading"). A node with no sample has none.
	 */
	async seriesNames(nodeId: string): Promise<string[]> {
		const rows = await this.#db
			.selectFrom("metric_series")
			.select("name")
			.where("node_id", "=", nodeId)
			.orderBy("name")
			.execute();
		return rows.map((row) => row.name);
	}

	/**
	 * A node's traffic for the current period, or undefined before its first traffic row. A period that
	 * already ended is rolled before it is returned, so a node that sent nothing while crhs was down still
	 * shows the period that contains now; the roll is written back only when it happened, so the common
	 * read does not write (doc/design/metrics.md "Traffic totals").
	 */
	traffic(nodeId: string, nowMs: number = this.#now()): Promise<NodeTraffic | undefined> {
		// Serialized with the flush that adds the next value, so a roll cannot interleave with a batch
		// that read the old period and would write it back.
		return this.#exclusive(async () => {
			const row = await this.#trafficRow(nodeId);
			if (row === undefined) return undefined;
			const stored = trafficOfRow(row);
			const rolled = rollTrafficPeriod(stored, nowMs);
			if (rolled.nextResetAtMs !== stored.nextResetAtMs) {
				// The old end is part of the condition: a reset or a new end that already happened wins.
				await this.#db
					.updateTable("node_traffic")
					.set(trafficColumns(rolled))
					.where("node_id", "=", nodeId)
					.where("next_reset_at", "=", row.next_reset_at)
					.execute();
			}
			return { nodeId, ...rolled };
		});
	}

	/**
	 * The traffic periods of several nodes, with every expired period rolled in memory only
	 * (doc/design/metrics.md "Traffic totals"). This is the node list's read: one statement per chunk of
	 * ids, no write-back, so a rolled period shows zero totals until the next sample or mutation writes it.
	 * It must never write, so it is not serialized with the flush chain.
	 */
	async trafficForNodes(nodeIds: readonly string[], nowMs: number = this.#now()): Promise<Map<string, NodeTraffic>> {
		const traffic = new Map<string, NodeTraffic>();
		const ids = [...new Set(nodeIds)];
		for (const chunk of chunks(ids, FLUSH_CHUNK_SIZE)) {
			const rows = await this.#db
				.selectFrom("node_traffic")
				.select(["node_id", "period_start", "next_reset_at", "rx_bytes", "tx_bytes"])
				.where("node_id", "in", chunk)
				.execute();
			for (const row of rows) {
				traffic.set(row.node_id, { nodeId: row.node_id, ...rollTrafficPeriod(trafficOfRow(row), nowMs) });
			}
		}
		return traffic;
	}

	/**
	 * "Reset now": the totals go to zero and a new period starts at `nowMs`. A row is created when the node
	 * had none, so the next sample adds to this period rather than starting an older one.
	 */
	resetTraffic(nodeId: string, nowMs: number = this.#now()): Promise<NodeTraffic> {
		return this.#exclusive(async () => {
			const period = newTrafficPeriod(nowMs);
			await this.#upsertTraffic([{ node_id: nodeId, ...trafficColumns(period) }]);
			return { nodeId, ...period };
		});
	}

	/**
	 * Sets when the current period ends, keeping its start and totals; the normal 30-day cycle continues
	 * from the new end. A period that already ended is rolled first, so the change applies to the period
	 * that contains now. The caller validates the instant; a missing row is created starting now.
	 */
	setTrafficNextReset(nodeId: string, nextResetAtMs: number, nowMs: number = this.#now()): Promise<NodeTraffic> {
		return this.#exclusive(async () => {
			const row = await this.#trafficRow(nodeId);
			const current = row === undefined ? newTrafficPeriod(nowMs) : rollTrafficPeriod(trafficOfRow(row), nowMs);
			const period = { ...current, nextResetAtMs };
			await this.#upsertTraffic([{ node_id: nodeId, ...trafficColumns(period) }]);
			return { nodeId, ...period };
		});
	}

	async #trafficRow(nodeId: string): Promise<TrafficRow | undefined> {
		return this.#db
			.selectFrom("node_traffic")
			.select(["node_id", "period_start", "next_reset_at", "rx_bytes", "tx_bytes"])
			.where("node_id", "=", nodeId)
			.executeTakeFirst();
	}

	/** Upserts traffic rows in one statement per chunk, so a reset writes once, not once per column. */
	async #upsertTraffic(rows: readonly TrafficRow[]): Promise<void> {
		await this.#upsertTrafficIn(this.#db, rows);
	}

	/**
	 * The level {@link read} chooses for a range when the caller names none; exposed so a response can say
	 * which level it used. `seriesCount` lets it pick a coarser level when the finest useful one would return
	 * more than {@link MAX_METRICS_READ_POINTS}, and `nowMs` lets the caller pass the same clock reading it
	 * used for `from`/`to`.
	 */
	chooseLevel(fromMs: number, toMs: number, seriesCount = 1, nowMs: number = this.#now()): MetricLevel {
		const chosen = chooseMetricsLevel({
			fromMs,
			toMs,
			nowMs,
			retention: this.#retention(),
		});
		return fitMetricsReadLevel(chosen, seriesCount, fromMs, toMs);
	}

	/**
	 * Deletes buckets past their level's retention and the series left without buckets
	 * (doc/design/metrics.md "Storage"), dropping those series from the id cache. The hourly retention run
	 * calls this with its batch size and abort signal.
	 */
	sweep(
		retention: MetricsRetentionConfig = this.#retention(),
		nowMs: number = this.#now(),
		options: MetricsRetentionSweepOptions = {},
	): Promise<MetricsSweepResult> {
		// Serialized with the flush chain: a sweep that ran during a flush could delete a series whose new
		// buckets the flush is about to write (doc/design/metrics.md "Storage").
		return this.#exclusive(async () => {
			const result: MetricsRetentionSweepResult = await sweepMetricRetention(this.#db, retention, nowMs, options);
			this.forgetSeries(result.seriesIds);
			// The cap cache must not grow with series that retention removed; an unflushed name is re-added on
			// the next flush, when the set is loaded from what the database still has.
			this.#seriesNames.clear();
			return { buckets: result.buckets, series: result.seriesIds.length };
		});
	}

	/** Drops series ids from the cache, e.g. after retention or a node deletion removed their rows. */
	forgetSeries(seriesIds: readonly string[]): void {
		if (seriesIds.length === 0) return;
		const removed = new Set(seriesIds);
		for (const [key, entry] of this.#seriesCache) {
			if (!removed.has(entry.id)) continue;
			this.#seriesCache.delete(key);
			this.#seriesNames.get(entry.nodeId)?.delete(entry.name);
		}
	}

	/** Drops cached series ids of nodes whose row, and therefore whose series, is gone. */
	#forgetNodes(nodeIds: ReadonlySet<string>): void {
		if (nodeIds.size === 0) return;
		for (const [key, entry] of this.#seriesCache) {
			if (nodeIds.has(entry.nodeId)) this.#seriesCache.delete(key);
		}
		for (const nodeId of nodeIds) {
			this.#seriesNames.delete(nodeId);
			this.#seriesCapLoggedAt.delete(nodeId);
		}
	}

	/** Keeps the buffer under the cap by dropping whole oldest samples and counting their values. */
	#trimPending(): void {
		if (this.#pendingValues <= METRICS_MAX_PENDING_VALUES) return;
		let dropped = 0;
		while (this.#pendingValues > METRICS_MAX_PENDING_VALUES && this.#pendingStart < this.#pending.length) {
			const sample = this.#pending[this.#pendingStart];
			if (sample === undefined) break;
			this.#pendingStart += 1;
			this.#pendingValues -= sample.values.length;
			dropped += sample.values.length;
		}
		this.#overflowDropped += dropped;
		// Drop the consumed prefix in one move once it is worth it, so a record past the cap stays O(1)
		// amortized rather than shifting the whole buffer.
		if (this.#pendingStart === this.#pending.length) {
			this.#pending = [];
			this.#pendingStart = 0;
		} else if (this.#pendingStart >= 1024 && this.#pendingStart * 2 >= this.#pending.length) {
			this.#pending = this.#pending.slice(this.#pendingStart);
			this.#pendingStart = 0;
		}
	}

	/** Logs the values dropped past the cap once per flush, not once per record. */
	#logOverflowDropped(): void {
		if (this.#overflowDropped === 0) return;
		const dropped = this.#overflowDropped;
		this.#overflowDropped = 0;
		console.error(
			`metrics: dropped ${dropped} buffered value${dropped === 1 ? "" : "s"} over the ${METRICS_MAX_PENDING_VALUES}-value buffer limit`,
		);
	}

	async #flushOnce(): Promise<void> {
		this.#logOverflowDropped();
		if (this.#pendingStart >= this.#pending.length) return;
		const samples = this.#pendingStart === 0 ? this.#pending : this.#pending.slice(this.#pendingStart);
		this.#pending = [];
		this.#pendingStart = 0;
		this.#pendingValues = 0;
		try {
			const capped = await this.#applySeriesCap(samples);
			const aggregates = aggregateSamples(capped);
			const traffic = trafficDeltas(capped);
			if (aggregates.length === 0 && traffic.size === 0) return;
			const nodeIds = [...new Set([...aggregates.map((aggregate) => aggregate.nodeId), ...traffic.keys()])];
			await this.#db.transaction().execute(async (trx) => {
				// A node may be deleted between record() and this flush; its series cascade away, so writing
				// its aggregates would fail the whole transaction with a foreign key error. The existence
				// check is the transaction's first statement, before anything is written.
				const liveNodeIds = await this.#liveNodeIds(trx, nodeIds);
				const missing = new Set(nodeIds.filter((nodeId) => !liveNodeIds.has(nodeId)));
				if (missing.size > 0) this.#forgetNodes(missing);
				const live = aggregates.filter((aggregate) => !missing.has(aggregate.nodeId));
				if (live.length > 0) {
					const entries = await this.#resolveSeries(trx, live);
					const bucketRows: BucketRow[] = [];
					for (const aggregate of live) {
						const entry = entries.get(seriesCacheKey(aggregate.nodeId, aggregate.name));
						// #resolveSeries resolves every live aggregate; this only narrows the type.
						if (entry === undefined) continue;
						await this.#touchLastSeen(trx, aggregate, entry);
						for (const bucket of aggregate.buckets) {
							bucketRows.push({
								series_id: entry.id,
								level: bucket.level,
								bucket_start: bucket.bucketStart,
								count: bucket.count,
								sum: bucket.sum,
								min: bucket.min,
								max: bucket.max,
								last: bucket.last,
							});
						}
					}
					await this.#upsertBuckets(trx, bucketRows);
				}
				await this.#addTraffic(trx, traffic, liveNodeIds);
			});
		} catch (err) {
			this.#requeueAfterFailure(samples, err);
			throw err;
		}
	}

	/**
	 * Drops values whose series would push a node past {@link MAX_METRICS_SERIES_PER_NODE}
	 * (doc/design/metrics.md "Limits"). A name the node already has always records; only a name first seen
	 * after the cap is full is dropped, and the drop is logged once per node per hour.
	 */
	async #applySeriesCap(samples: readonly BufferedSample[]): Promise<BufferedSample[]> {
		const namesByNode = new Map<string, Set<string>>();
		for (const sample of samples) {
			if (namesByNode.has(sample.nodeId)) continue;
			namesByNode.set(sample.nodeId, await this.#seriesNamesFor(sample.nodeId));
		}
		const droppedByNode = new Map<string, string[]>();
		const capped: BufferedSample[] = [];
		for (const sample of samples) {
			const names = namesByNode.get(sample.nodeId) as Set<string>;
			const kept: MetricValue[] = [];
			for (const value of sample.values) {
				if (names.has(value.name)) {
					kept.push(value);
					continue;
				}
				if (names.size < MAX_METRICS_SERIES_PER_NODE) {
					names.add(value.name);
					kept.push(value);
					continue;
				}
				const dropped = droppedByNode.get(sample.nodeId) ?? [];
				dropped.push(value.name);
				droppedByNode.set(sample.nodeId, dropped);
			}
			if (kept.length > 0) capped.push({ ...sample, values: kept });
		}
		for (const [nodeId, dropped] of droppedByNode) {
			const now = this.#now();
			const previous = this.#seriesCapLoggedAt.get(nodeId) ?? Number.NEGATIVE_INFINITY;
			if (now - previous < SERIES_CAP_LOG_INTERVAL_MS) continue;
			this.#seriesCapLoggedAt.set(nodeId, now);
			const first = [...new Set(dropped)].slice(0, 3).join(", ");
			console.error(
				`metrics: node ${nodeId}: dropped ${dropped.length} value${dropped.length === 1 ? "" : "s"} of new series over the ${MAX_METRICS_SERIES_PER_NODE}-series limit (${first})`,
			);
		}
		return capped;
	}

	/** The names of every series a node has, read once and kept current as this store creates series. */
	async #seriesNamesFor(nodeId: string): Promise<Set<string>> {
		const cached = this.#seriesNames.get(nodeId);
		if (cached !== undefined) return cached;
		const rows = await this.#db.selectFrom("metric_series").select("name").where("node_id", "=", nodeId).execute();
		const names = new Set(rows.map((row) => row.name));
		this.#seriesNames.set(nodeId, names);
		return names;
	}

	/**
	 * Puts the samples of a failed flush back once. A sample that fails a second time is dropped: a permanent
	 * error (a series another process removed, a node deleted mid-flush) would otherwise fail every later
	 * transaction forever and grow the buffer without bound. A failed transaction may have left any cached id
	 * stale, so the whole cache is cleared and the retry resolves the series again.
	 */
	#requeueAfterFailure(samples: readonly BufferedSample[], err: unknown): void {
		this.#seriesCache.clear();
		const retry: BufferedSample[] = [];
		let dropped = 0;
		let keptValues = 0;
		for (const sample of samples) {
			if (sample.failedFlushes > 0) {
				dropped += sample.values.length;
				continue;
			}
			sample.failedFlushes += 1;
			retry.push(sample);
			keptValues += sample.values.length;
		}
		// Newer records stay after the retried ones, in order.
		const pending = this.#pendingStart === 0 ? this.#pending : this.#pending.slice(this.#pendingStart);
		this.#pending = [...retry, ...pending];
		this.#pendingStart = 0;
		this.#pendingValues += keptValues;
		if (dropped > 0) {
			const reason = errorText(err).replace(/\s+/g, " ").trim();
			console.error(
				`metrics: dropped ${dropped} buffered value${dropped === 1 ? "" : "s"} after a second failed flush: ${reason}`,
			);
		}
		this.#trimPending();
		this.#logOverflowDropped();
	}

	/** The nodes of this flush that still exist, selected in chunks as part of the transaction. */
	async #liveNodeIds(trx: Transaction<Database>, nodeIds: readonly string[]): Promise<Set<string>> {
		const live = new Set<string>();
		for (const chunk of chunks([...new Set(nodeIds)], FLUSH_CHUNK_SIZE)) {
			const rows = await trx.selectFrom("nodes").select("id").where("id", "in", chunk).execute();
			for (const row of rows) live.add(row.id);
		}
		return live;
	}

	/**
	 * Adds the flush's network deltas to each live node's traffic row
	 * (doc/design/metrics.md "Traffic totals"). Values are applied in slot order, and a period that ended is
	 * rolled before its first value, so a flush that spans a period boundary starts the new period at the
	 * old end. The rows are written with one multi-row upsert per chunk, never one statement per node.
	 */
	async #addTraffic(
		trx: Transaction<Database>,
		traffic: ReadonlyMap<string, readonly TrafficDelta[]>,
		liveNodeIds: ReadonlySet<string>,
	): Promise<void> {
		const nodeIds = [...traffic.keys()].filter((nodeId) => liveNodeIds.has(nodeId));
		if (nodeIds.length === 0) return;
		const stored = new Map<string, TrafficRow>();
		for (const chunk of chunks(nodeIds, FLUSH_CHUNK_SIZE)) {
			const rows = await trx
				.selectFrom("node_traffic")
				.select(["node_id", "period_start", "next_reset_at", "rx_bytes", "tx_bytes"])
				.where("node_id", "in", chunk)
				.execute();
			for (const row of rows) stored.set(row.node_id, row);
		}
		const rows: TrafficRow[] = [];
		for (const nodeId of nodeIds) {
			let period = stored.has(nodeId) ? trafficOfRow(stored.get(nodeId) as TrafficRow) : undefined;
			for (const value of traffic.get(nodeId) ?? []) {
				// A value recorded before the current period started arrived too late to belong to it: a reset
				// (or a period roll) happened between its sample and this flush, and counting it would carry
				// the old period's traffic into the new one (doc/design/metrics.md "Traffic totals").
				if (period !== undefined && value.slotStartMs < period.periodStartMs) continue;
				// A missing row starts at the value's slot; an existing one rolls from its current bounds.
				const current =
					period === undefined ? newTrafficPeriod(value.slotStartMs) : rollTrafficPeriod(period, value.slotStartMs);
				period = {
					...current,
					rxBytes: current.rxBytes + value.rxBytes,
					txBytes: current.txBytes + value.txBytes,
				};
			}
			if (period !== undefined) rows.push({ node_id: nodeId, ...trafficColumns(period) });
		}
		await this.#upsertTrafficIn(trx, rows);
	}

	/** The transaction-scoped half of {@link #upsertTraffic}, shared by flushes and mutations. */
	async #upsertTrafficIn(writer: Db | Transaction<Database>, rows: readonly TrafficRow[]): Promise<void> {
		for (const chunk of chunks(rows, FLUSH_CHUNK_SIZE)) {
			await writer
				.insertInto("node_traffic")
				.values(chunk)
				.onConflict((oc) =>
					oc.column("node_id").doUpdateSet({
						period_start: sql<string>`${sql.ref("excluded.period_start")}`,
						next_reset_at: sql<string>`${sql.ref("excluded.next_reset_at")}`,
						rx_bytes: sql<number>`${sql.ref("excluded.rx_bytes")}`,
						tx_bytes: sql<number>`${sql.ref("excluded.tx_bytes")}`,
					}),
				)
				.execute();
		}
	}

	/**
	 * Maps every aggregate to its series id inside the flush transaction. Cached ids are used as they are;
	 * the others are resolved with one SELECT per chunk of `(node_id, name)` pairs and created with one
	 * multi-row INSERT per chunk, instead of a SELECT and an INSERT per series.
	 */
	async #resolveSeries(
		trx: Transaction<Database>,
		aggregates: readonly SeriesAggregate[],
	): Promise<Map<string, SeriesCacheEntry>> {
		const entries = new Map<string, SeriesCacheEntry>();
		const unresolved: SeriesAggregate[] = [];
		for (const aggregate of aggregates) {
			const key = seriesCacheKey(aggregate.nodeId, aggregate.name);
			const cached = this.#seriesCache.get(key);
			if (cached === undefined) unresolved.push(aggregate);
			else entries.set(key, cached);
		}
		if (unresolved.length === 0) return entries;

		// The row-value IN is understood by both SQLite and PostgreSQL and keeps one statement per chunk.
		const existing = new Map<string, SeriesRow>();
		for (const chunk of chunks(unresolved, FLUSH_CHUNK_SIZE)) {
			const pairs = sql.join(
				chunk.map((aggregate) => sql`(${aggregate.nodeId}, ${aggregate.name})`),
				sql`, `,
			);
			const rows = await trx
				.selectFrom("metric_series")
				.select(["id", "node_id", "name", "kind", "last_seen_at"])
				.where(sql<SqlBool>`(node_id, name) in (${pairs})`)
				.execute();
			for (const row of rows) existing.set(seriesCacheKey(row.node_id, row.name), row);
		}

		const created: SeriesAggregate[] = [];
		for (const aggregate of unresolved) {
			const key = seriesCacheKey(aggregate.nodeId, aggregate.name);
			const row = existing.get(key);
			if (row === undefined) {
				created.push(aggregate);
				continue;
			}
			const entry: SeriesCacheEntry = {
				id: row.id,
				nodeId: aggregate.nodeId,
				name: aggregate.name,
				kind: row.kind,
				lastSeenMs: Date.parse(row.last_seen_at),
			};
			this.#seriesCache.set(key, entry);
			entries.set(key, entry);
		}

		for (const chunk of chunks(created, FLUSH_CHUNK_SIZE)) {
			const newRows = chunk.map((aggregate) => ({ aggregate, id: newId() }));
			await trx
				.insertInto("metric_series")
				.values(
					newRows.map(({ aggregate, id }) => ({
						id,
						node_id: aggregate.nodeId,
						name: aggregate.name,
						kind: aggregate.kind,
						first_seen_at: new Date(aggregate.firstSlotMs).toISOString(),
						last_seen_at: new Date(aggregate.lastSlotMs).toISOString(),
					})),
				)
				.execute();
			for (const { aggregate, id } of newRows) {
				const key = seriesCacheKey(aggregate.nodeId, aggregate.name);
				const entry: SeriesCacheEntry = {
					id,
					nodeId: aggregate.nodeId,
					name: aggregate.name,
					kind: aggregate.kind,
					lastSeenMs: aggregate.lastSlotMs,
				};
				this.#seriesCache.set(key, entry);
				entries.set(key, entry);
			}
		}
		return entries;
	}

	/** Writes `last_seen_at` once per level-2 bucket, and never moves it backwards on a retroactive write. */
	async #touchLastSeen(trx: Transaction<Database>, aggregate: SeriesAggregate, entry: SeriesCacheEntry): Promise<void> {
		const bucket = metricBucketStart(aggregate.lastSlotMs, 2);
		const storedBucket = Number.isFinite(entry.lastSeenMs)
			? metricBucketStart(entry.lastSeenMs, 2)
			: Number.NEGATIVE_INFINITY;
		if (bucket <= storedBucket) return;
		await trx
			.updateTable("metric_series")
			.set({ last_seen_at: new Date(aggregate.lastSlotMs).toISOString() })
			.where("id", "=", entry.id)
			.execute();
		entry.lastSeenMs = aggregate.lastSlotMs;
	}

	/**
	 * Upserts the flush's buckets with one multi-row INSERT ... ON CONFLICT per chunk: `count`/`sum` add,
	 * `min`/`max` compare and `last` takes the excluded row's value. The in-memory aggregation makes every
	 * `(series_id, level, bucket_start)` unique within a statement, as PostgreSQL requires.
	 */
	async #upsertBuckets(trx: Transaction<Database>, rows: readonly BucketRow[]): Promise<void> {
		for (const chunk of chunks(rows, FLUSH_CHUNK_SIZE)) {
			await trx
				.insertInto("metric_buckets")
				.values(chunk)
				.onConflict((oc) =>
					oc.columns(["series_id", "level", "bucket_start"]).doUpdateSet({
						count: sql<number>`${sql.ref("metric_buckets.count")} + ${sql.ref("excluded.count")}`,
						sum: sql<number>`${sql.ref("metric_buckets.sum")} + ${sql.ref("excluded.sum")}`,
						// CASE instead of LEAST/GREATEST or min/max: SQLite has the two-argument functions and
						// PostgreSQL does not, while CASE is the same on both.
						min: sql<number>`case when ${sql.ref("metric_buckets.min")} < ${sql.ref("excluded.min")} then ${sql.ref("metric_buckets.min")} else ${sql.ref("excluded.min")} end`,
						max: sql<number>`case when ${sql.ref("metric_buckets.max")} > ${sql.ref("excluded.max")} then ${sql.ref("metric_buckets.max")} else ${sql.ref("excluded.max")} end`,
						last: sql<number>`${sql.ref("excluded.last")}`,
					}),
				)
				.execute();
		}
	}
}

/** A stored traffic row as the 30-day period logic uses it. */
function trafficOfRow(row: TrafficRow): TrafficPeriod {
	return {
		periodStartMs: Date.parse(row.period_start),
		nextResetAtMs: Date.parse(row.next_reset_at),
		rxBytes: row.rx_bytes,
		txBytes: row.tx_bytes,
	};
}

/** The columns of a traffic row, with instants stored as ISO 8601 (doc/design/metrics.md "Storage"). */
function trafficColumns(period: TrafficPeriod): Omit<TrafficRow, "node_id"> {
	return {
		period_start: new Date(period.periodStartMs).toISOString(),
		next_reset_at: new Date(period.nextResetAtMs).toISOString(),
		rx_bytes: period.rxBytes,
		tx_bytes: period.txBytes,
	};
}

/**
 * The network deltas of the buffered samples, by node in slot order. A sample without `net.rx_bytes` or
 * `net.tx_bytes` contributes nothing, and both values of one sample are added together, so the totals
 * follow the deltas the computation produced (doc/design/metrics.md "Traffic totals").
 */
function trafficDeltas(samples: readonly BufferedSample[]): Map<string, TrafficDelta[]> {
	const byNode = new Map<string, TrafficDelta[]>();
	for (const sample of samples) {
		let rxBytes = 0;
		let txBytes = 0;
		let observed = false;
		for (const value of sample.values) {
			if (!Number.isFinite(value.value)) continue;
			if (value.name === "net.rx_bytes") {
				rxBytes += value.value;
				observed = true;
			} else if (value.name === "net.tx_bytes") {
				txBytes += value.value;
				observed = true;
			}
		}
		if (!observed) continue;
		const list = byNode.get(sample.nodeId) ?? [];
		list.push({ slotStartMs: sample.slotStartMs, rxBytes, txBytes });
		byNode.set(sample.nodeId, list);
	}
	for (const list of byNode.values()) list.sort((left, right) => left.slotStartMs - right.slotStartMs);
	return byNode;
}

function seriesCacheKey(nodeId: string, name: string): string {
	return `${nodeId}\u0000${name}`;
}

/** Splits items into consecutive chunks of at most `size`, keeping their order. */
function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}

/** Whether a series is kept at level 1 only (doc/design/metrics.md "Storage"). */
function isLevel1Only(name: string): boolean {
	return name.startsWith("cpu.core.");
}

/**
 * Combines the buffered values in memory before writing: several samples of one series and bucket become
 * one upsert, so the database sees one addition and the row's `last` comes from the newest slot.
 */
function aggregateSamples(samples: readonly BufferedSample[]): SeriesAggregate[] {
	const seriesMap = new Map<string, SeriesAggregate & { bucketMap: Map<string, BucketAggregate> }>();
	for (const sample of samples) {
		for (const value of sample.values) {
			// A non-finite number is not a sample; the collector omits a missing value instead.
			if (!Number.isFinite(value.value)) continue;
			const key = seriesCacheKey(sample.nodeId, value.name);
			let series = seriesMap.get(key);
			if (!series) {
				series = {
					nodeId: sample.nodeId,
					name: value.name,
					kind: value.kind,
					firstSlotMs: sample.slotStartMs,
					lastSlotMs: sample.slotStartMs,
					buckets: [],
					bucketMap: new Map(),
				};
				seriesMap.set(key, series);
			}
			if (sample.slotStartMs < series.firstSlotMs) series.firstSlotMs = sample.slotStartMs;
			if (sample.slotStartMs > series.lastSlotMs) series.lastSlotMs = sample.slotStartMs;
			const levels = isLevel1Only(value.name) ? ([1] as const) : METRIC_LEVELS;
			for (const level of levels) {
				const bucketStart = metricBucketStart(sample.slotStartMs, level);
				const bucketKey = `${level}:${bucketStart}`;
				const bucket = series.bucketMap.get(bucketKey);
				if (!bucket) {
					series.bucketMap.set(bucketKey, {
						level,
						bucketStart,
						count: 1,
						sum: value.value,
						min: value.value,
						max: value.value,
						last: value.value,
						lastSlotMs: sample.slotStartMs,
					});
					continue;
				}
				bucket.count += 1;
				bucket.sum += value.value;
				if (value.value < bucket.min) bucket.min = value.value;
				if (value.value > bucket.max) bucket.max = value.value;
				if (sample.slotStartMs >= bucket.lastSlotMs) {
					bucket.last = value.value;
					bucket.lastSlotMs = sample.slotStartMs;
				}
			}
		}
	}
	return [...seriesMap.values()].map(({ bucketMap, ...series }) => ({
		...series,
		buckets: [...bucketMap.values()],
	}));
}

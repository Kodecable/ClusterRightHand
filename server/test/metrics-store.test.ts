import { type KyselyPlugin, sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	chooseMetricsLevel,
	DEFAULT_METRICS_RETENTION_MS,
	METRIC_LEVEL_BUCKET_MS,
	type MetricsRetentionConfig,
} from "../src/metrics/levels.ts";
import { MAX_METRICS_SERIES_PER_NODE, METRICS_MAX_PENDING_VALUES, MetricsStore } from "../src/metrics/store.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { newId } from "../src/util/id.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SLOT = Date.UTC(2026, 5, 1, 10, 0);

async function addNode(db: Db, name = "node-1", id = newId()): Promise<string> {
	const now = new Date().toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name,
			name_key: name.toLowerCase(),
			transport: "client",
			status: "active",
			public_key: null,
			hostname: name,
			facts: null,
			client_version: null,
			privileged_mode: null,
			last_seen_at: null,
			created_at: now,
			approved_at: now,
			approved_by_user_id: null,
			ssh_host: null,
			ssh_port: null,
			ssh_user: null,
			ssh_host_fingerprint: null,
			ssh_credential_id: null,
			ssh_jumps: null,
		})
		.execute();
	return id;
}

interface StoredBucket {
	name: string;
	level: number;
	bucket_start: number;
	count: number;
	sum: number;
	min: number;
	max: number;
	last: number;
}

async function storedBuckets(db: Db, nodeId: string): Promise<StoredBucket[]> {
	return db
		.selectFrom("metric_buckets as b")
		.innerJoin("metric_series as s", "s.id", "b.series_id")
		.select(["s.name", "b.level", "b.bucket_start", "b.count", "b.sum", "b.min", "b.max", "b.last"])
		.where("s.node_id", "=", nodeId)
		.orderBy("s.name")
		.orderBy("b.level")
		.orderBy("b.bucket_start")
		.execute();
}

async function seriesRows(db: Db, nodeId: string) {
	return db
		.selectFrom("metric_series")
		.select(["name", "kind", "first_seen_at", "last_seen_at"])
		.where("node_id", "=", nodeId)
		.orderBy("name")
		.execute();
}

/** A database that rejects its first `failures` statements, as a briefly unavailable database would. */
function failingDb(db: Db, failures: number): Db {
	let remaining = failures;
	const plugin: KyselyPlugin = {
		transformQuery(args) {
			if (remaining === 0) return args.node;
			remaining -= 1;
			throw new Error("database unavailable");
		},
		async transformResult(args) {
			return args.result;
		},
	};
	return db.withPlugin(plugin);
}

describeBackends("metrics migration", (backend) => {
	let db: Db;

	beforeAll(async () => {
		db = await openTestDb(backend);
	});
	afterAll(async () => {
		await db.destroy();
	});

	it("creates both tables with their keys and constraints", async () => {
		const columns = async (table: string): Promise<string[]> => {
			if (backend === "postgres") {
				const result = await sql<{ column_name: string }>`
					select column_name from information_schema.columns
					where table_schema = current_schema() and table_name = ${table}
					order by ordinal_position
				`.execute(db);
				return result.rows.map((row) => row.column_name);
			}
			const result = await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(db);
			return result.rows.map((row) => row.name);
		};
		expect(await columns("metric_series")).toEqual(["id", "node_id", "name", "kind", "first_seen_at", "last_seen_at"]);
		expect(await columns("metric_buckets")).toEqual([
			"series_id",
			"level",
			"bucket_start",
			"count",
			"sum",
			"min",
			"max",
			"last",
		]);
		const nodeId = await addNode(db, "migration-node");
		const seriesId = newId();
		await db
			.insertInto("metric_series")
			.values({
				id: seriesId,
				node_id: nodeId,
				name: "up",
				kind: "gauge",
				first_seen_at: "2026-06-01T00:00:00.000Z",
				last_seen_at: "2026-06-01T00:00:00.000Z",
			})
			.execute();
		// The kind, level and series/node uniqueness are database constraints, not just application rules.
		await expect(
			db
				.insertInto("metric_series")
				.values({
					id: newId(),
					node_id: nodeId,
					name: "up",
					kind: "gauge",
					first_seen_at: "2026-06-01T00:00:00.000Z",
					last_seen_at: "2026-06-01T00:00:00.000Z",
				})
				.execute(),
		).rejects.toThrow();
		await expect(
			db
				.insertInto("metric_series")
				.values({
					id: newId(),
					node_id: nodeId,
					name: "broken",
					kind: "counter" as never,
					first_seen_at: "2026-06-01T00:00:00.000Z",
					last_seen_at: "2026-06-01T00:00:00.000Z",
				})
				.execute(),
		).rejects.toThrow();
		await expect(
			db
				.insertInto("metric_buckets")
				.values({
					series_id: seriesId,
					level: 5,
					bucket_start: SLOT,
					count: 1,
					sum: 1,
					min: 1,
					max: 1,
					last: 1,
				})
				.execute(),
		).rejects.toThrow();
	});

	it("stores bucket_start as a 64-bit integer on PostgreSQL", async () => {
		if (backend !== "postgres") return;
		const result = await sql<{ data_type: string }>`
			select data_type from information_schema.columns
			where table_schema = current_schema() and table_name = 'metric_buckets' and column_name = 'bucket_start'
		`.execute(db);
		expect(result.rows[0]?.data_type).toBe("bigint");
	});
});

describeBackends("metrics store", (backend) => {
	let db: Db;
	let nodeId: string;
	let store: MetricsStore;

	beforeEach(async () => {
		db = await openTestDb(backend);
		nodeId = await addNode(db, "web-1");
		store = new MetricsStore(db, { timer: false });
	});
	afterEach(async () => {
		await store.close();
		await db.destroy();
		vi.restoreAllMocks();
	});

	it("writes a value into every level and cpu.core only into level 1", async () => {
		store.record(nodeId, SLOT, [
			{ name: "cpu.total", kind: "gauge", value: 0.5 },
			{ name: "cpu.core.0", kind: "gauge", value: 0.25 },
			{ name: "net.rx_bytes", kind: "delta", value: 1200 },
		]);
		await store.flush();

		expect(await seriesRows(db, nodeId)).toEqual([
			{
				name: "cpu.core.0",
				kind: "gauge",
				first_seen_at: new Date(SLOT).toISOString(),
				last_seen_at: new Date(SLOT).toISOString(),
			},
			{
				name: "cpu.total",
				kind: "gauge",
				first_seen_at: new Date(SLOT).toISOString(),
				last_seen_at: new Date(SLOT).toISOString(),
			},
			{
				name: "net.rx_bytes",
				kind: "delta",
				first_seen_at: new Date(SLOT).toISOString(),
				last_seen_at: new Date(SLOT).toISOString(),
			},
		]);

		const buckets = await storedBuckets(db, nodeId);
		const forSeries = (name: string) => buckets.filter((bucket) => bucket.name === name);
		for (const [name, value] of [
			["cpu.total", 0.5],
			["net.rx_bytes", 1200],
		] as const) {
			expect(
				forSeries(name).map((bucket) => ({
					level: bucket.level,
					bucket_start: bucket.bucket_start,
					count: bucket.count,
					sum: bucket.sum,
					min: bucket.min,
					max: bucket.max,
					last: bucket.last,
				})),
			).toEqual(
				([1, 2, 3, 4] as const).map((level) => ({
					level,
					bucket_start: Math.floor(SLOT / METRIC_LEVEL_BUCKET_MS[level]) * METRIC_LEVEL_BUCKET_MS[level],
					count: 1,
					sum: value,
					min: value,
					max: value,
					last: value,
				})),
			);
		}
		const core = forSeries("cpu.core.0");
		expect(core).toHaveLength(1);
		expect(core[0]).toMatchObject({ level: 1, bucket_start: SLOT, count: 1, sum: 0.25, last: 0.25 });
	});

	it("combines several values of one bucket in one flush and across flushes", async () => {
		store.record(nodeId, SLOT, [{ name: "cpu.total", kind: "gauge", value: 1 }]);
		await store.flush();
		store.record(nodeId, SLOT + MINUTE, [{ name: "cpu.total", kind: "gauge", value: 3 }]);
		await store.flush();
		store.record(nodeId, SLOT + 2 * MINUTE, [{ name: "cpu.total", kind: "gauge", value: 2 }]);
		store.record(nodeId, SLOT + 3 * MINUTE, [{ name: "cpu.total", kind: "gauge", value: 5 }]);
		await store.flush();

		const buckets = (await storedBuckets(db, nodeId)).filter((bucket) => bucket.level === 2);
		expect(buckets).toEqual([
			{
				name: "cpu.total",
				level: 2,
				bucket_start: SLOT,
				count: 4,
				sum: 11,
				min: 1,
				max: 5,
				last: 5,
			},
		]);
		// Every level-1 bucket holds its own sample.
		const level1 = (await storedBuckets(db, nodeId)).filter((bucket) => bucket.level === 1);
		expect(level1.map((bucket) => [bucket.bucket_start, bucket.count, bucket.last])).toEqual([
			[SLOT, 1, 1],
			[SLOT + MINUTE, 1, 3],
			[SLOT + 2 * MINUTE, 1, 2],
			[SLOT + 3 * MINUTE, 1, 5],
		]);
	});

	it("keeps last from the newest slot when earlier slots are recorded later", async () => {
		// The first record is newer in slot time than the second: a retroactive write must not win last.
		store.record(nodeId, SLOT + 2 * MINUTE, [{ name: "up", kind: "gauge", value: 5 }]);
		store.record(nodeId, SLOT, [{ name: "up", kind: "gauge", value: 9 }]);
		await store.flush();

		const level2 = (await storedBuckets(db, nodeId)).filter((bucket) => bucket.level === 2);
		expect(level2).toEqual([{ name: "up", level: 2, bucket_start: SLOT, count: 2, sum: 14, min: 5, max: 9, last: 5 }]);
	});

	it("writes a past slot into the bucket it belongs to, including an earlier level 3 and 4 bucket", async () => {
		const past = Date.UTC(2026, 4, 30, 6, 30);
		store.record(nodeId, past, [{ name: "up", kind: "gauge", value: 0 }]);
		store.record(nodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.flush();

		const buckets = await storedBuckets(db, nodeId);
		// Levels 1-4 each got one bucket per slot; level 4 splits by day, level 3 by hour.
		expect(buckets.filter((bucket) => bucket.level === 3).map((bucket) => bucket.bucket_start)).toEqual([
			Date.UTC(2026, 4, 30, 6, 0),
			Date.UTC(2026, 5, 1, 10, 0),
		]);
		expect(buckets.filter((bucket) => bucket.level === 4).map((bucket) => bucket.bucket_start)).toEqual([
			Date.UTC(2026, 4, 30),
			Date.UTC(2026, 5, 1),
		]);
		// The current slot still updates last_seen_at; the retroactive write did not move it backwards.
		const series = await seriesRows(db, nodeId);
		expect(series[0]?.first_seen_at).toBe(new Date(past).toISOString());
		expect(series[0]?.last_seen_at).toBe(new Date(SLOT).toISOString());
	});

	it("does not move last_seen_at backwards when a new store writes a past slot", async () => {
		store.record(nodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.flush();
		// A restarted process has an empty id cache: it must load the stored last_seen_at before writing.
		const restarted = new MetricsStore(db, { timer: false });
		try {
			restarted.record(nodeId, SLOT - HOUR, [{ name: "up", kind: "gauge", value: 0 }]);
			await restarted.flush();
		} finally {
			await restarted.close();
		}
		expect((await seriesRows(db, nodeId))[0]?.last_seen_at).toBe(new Date(SLOT).toISOString());
		expect((await seriesRows(db, nodeId))[0]?.first_seen_at).toBe(new Date(SLOT).toISOString());
	});

	it("updates last_seen_at at most once per level 2 bucket", async () => {
		store.record(nodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.flush();
		store.record(nodeId, SLOT + MINUTE, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.flush();
		expect((await seriesRows(db, nodeId))[0]?.last_seen_at).toBe(new Date(SLOT).toISOString());

		// The next 5-minute bucket writes it once more.
		store.record(nodeId, SLOT + 5 * MINUTE, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.flush();
		expect((await seriesRows(db, nodeId))[0]?.last_seen_at).toBe(new Date(SLOT + 5 * MINUTE).toISOString());
	});

	it("reads buckets with the series kind and last_seen_at, and keeps a series without buckets", async () => {
		store.record(nodeId, SLOT, [{ name: "cpu.total", kind: "gauge", value: 0.5 }]);
		await store.flush();

		const read = await store.read(nodeId, ["cpu.total", "missing"], SLOT - HOUR, SLOT + HOUR, 1);
		expect(read).toEqual([
			{
				name: "cpu.total",
				kind: "gauge",
				lastSeenAt: new Date(SLOT).toISOString(),
				buckets: [{ bucketStart: SLOT, count: 1, sum: 0.5, min: 0.5, max: 0.5, last: 0.5 }],
			},
		]);
		// A series that stopped before the range is still returned, with no buckets, so the WebUI can mark it.
		const stopped = await store.read(nodeId, ["cpu.total"], SLOT + HOUR, SLOT + 2 * HOUR, 1);
		expect(stopped).toEqual([
			{
				name: "cpu.total",
				kind: "gauge",
				lastSeenAt: new Date(SLOT).toISOString(),
				buckets: [],
			},
		]);
	});

	it("chooses the level of a read from the range when none is named", async () => {
		const now = Date.UTC(2026, 5, 1, 12, 0);
		const chosen = new MetricsStore(db, { timer: false, now: () => now });
		try {
			chosen.record(nodeId, now - HOUR, [{ name: "up", kind: "gauge", value: 1 }]);
			chosen.record(nodeId, now - 7 * DAY, [{ name: "up", kind: "gauge", value: 1 }]);
			await chosen.flush();

			const oneHour = await chosen.read(nodeId, ["up"], now - HOUR, now);
			expect(oneHour[0]?.buckets.map((bucket) => bucket.bucketStart)).toEqual([now - HOUR]);
			const sevenDays = await chosen.read(nodeId, ["up"], now - 7 * DAY, now);
			// Level 2: a 5-minute bucket, because level 3 would give fewer than 200 points.
			expect(sevenDays[0]?.buckets[0]?.bucketStart).toBe(now - 7 * DAY);
			expect(sevenDays[0]?.buckets[0]?.bucketStart).toBe(
				Math.floor((now - 7 * DAY) / METRIC_LEVEL_BUCKET_MS[2]) * METRIC_LEVEL_BUCKET_MS[2],
			);
		} finally {
			await chosen.close();
		}
	});

	it("flushes the buffered samples once more when closed", async () => {
		store.record(nodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.close();
		expect(await storedBuckets(db, nodeId)).toHaveLength(4);
	});

	it("deletes a node's series and buckets with the node", async () => {
		store.record(nodeId, SLOT, [{ name: "cpu.total", kind: "gauge", value: 0.5 }]);
		await store.flush();
		await db.deleteFrom("nodes").where("id", "=", nodeId).execute();
		expect(await seriesRows(db, nodeId)).toEqual([]);
		expect(await storedBuckets(db, nodeId)).toEqual([]);
	});

	it("skips a node deleted before the flush, writes the others and forgets its cached series", async () => {
		const otherNodeId = await addNode(db, "web-2");
		store.record(nodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
		store.record(otherNodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.flush();

		await db.deleteFrom("nodes").where("id", "=", nodeId).execute();
		store.record(nodeId, SLOT + MINUTE, [{ name: "up", kind: "gauge", value: 2 }]);
		store.record(otherNodeId, SLOT + MINUTE, [{ name: "up", kind: "gauge", value: 2 }]);
		await store.flush();

		expect(await seriesRows(db, nodeId)).toEqual([]);
		expect(await storedBuckets(db, nodeId)).toEqual([]);
		expect((await storedBuckets(db, otherNodeId)).filter((bucket) => bucket.level === 2)).toEqual([
			{ name: "up", level: 2, bucket_start: SLOT, count: 2, sum: 3, min: 1, max: 2, last: 2 },
		]);

		// The deleted node's cached series ids were dropped: a node re-created with the same id writes anew.
		await addNode(db, "web-1", nodeId);
		store.record(nodeId, SLOT + 2 * MINUTE, [{ name: "up", kind: "gauge", value: 3 }]);
		await store.flush();
		expect(await seriesRows(db, nodeId)).toHaveLength(1);
	});

	it("clears the id cache after a failed flush so a stale series id is resolved again", async () => {
		store.record(nodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.flush();
		// Another process (or retention) removed the series while its id was still cached.
		await db.deleteFrom("metric_series").where("node_id", "=", nodeId).execute();
		store.record(nodeId, SLOT + MINUTE, [{ name: "up", kind: "gauge", value: 2 }]);

		await expect(store.flush()).rejects.toThrow();
		// The cache clear makes the retry resolve the series again instead of failing on the stale id.
		await store.flush();

		const series = await seriesRows(db, nodeId);
		expect(series).toHaveLength(1);
		expect(series[0]?.first_seen_at).toBe(new Date(SLOT + MINUTE).toISOString());
		expect((await storedBuckets(db, nodeId)).filter((bucket) => bucket.level === 2)).toEqual([
			{ name: "up", level: 2, bucket_start: SLOT, count: 1, sum: 2, min: 2, max: 2, last: 2 },
		]);
	});

	it("retries a failed flush once and drops its values on the second failure", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = new MetricsStore(failingDb(db, 2), { timer: false });
		try {
			failing.record(nodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
			await expect(failing.flush()).rejects.toThrow("database unavailable");
			expect(log).not.toHaveBeenCalled();

			await expect(failing.flush()).rejects.toThrow("database unavailable");
			const lines = log.mock.calls.map((call) => String(call[0]));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("dropped 1 buffered value");
			expect(lines[0]).toContain("database unavailable");

			// Nothing is left to retry, and the dropped values were never written.
			await failing.flush();
			expect(await seriesRows(db, nodeId)).toEqual([]);
		} finally {
			await failing.close();
		}
	});

	it("drops the oldest samples over the buffer cap and logs once at the next flush", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		store.record(nodeId, SLOT, [{ name: "oldest", kind: "gauge", value: 1 }]);
		// Non-finite values are never written, so the cap is exercised without writing 200,000 buckets.
		const filler = Array.from({ length: METRICS_MAX_PENDING_VALUES }, () => ({
			name: "ignored",
			kind: "gauge" as const,
			value: Number.NaN,
		}));
		store.record(nodeId, SLOT + MINUTE, filler);
		await store.flush();

		const lines = log.mock.calls.map((call) => String(call[0]));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("dropped 1 buffered value");
		expect(lines[0]).toContain(String(METRICS_MAX_PENDING_VALUES));

		store.record(nodeId, SLOT + 2 * MINUTE, [{ name: "newest", kind: "gauge", value: 2 }]);
		await store.flush();
		expect((await seriesRows(db, nodeId)).map((row) => row.name)).toEqual(["newest"]);
		expect(log).toHaveBeenCalledTimes(1);
	});

	it("writes more than 500 series and buckets through chunked statements", async () => {
		const seriesCount = 501;
		const values = Array.from({ length: seriesCount }, (_, index) => ({
			name: `series.${index}`,
			kind: "gauge" as const,
			value: index,
		}));
		store.record(nodeId, SLOT, values);
		await store.flush();

		expect(await seriesRows(db, nodeId)).toHaveLength(seriesCount);
		expect(await storedBuckets(db, nodeId)).toHaveLength(seriesCount * 4);

		// The same keys again: multi-row ON CONFLICT across chunk boundaries must add, not replace.
		store.record(nodeId, SLOT, values);
		await store.flush();
		const buckets = await storedBuckets(db, nodeId);
		expect(buckets).toHaveLength(seriesCount * 4);
		for (const bucket of buckets) {
			const value = Number(bucket.name.slice("series.".length));
			expect(bucket.count).toBe(2);
			expect(bucket.sum).toBe(value * 2);
			expect(bucket.min).toBe(value);
			expect(bucket.max).toBe(value);
			expect(bucket.last).toBe(value);
		}
	});

	it("caps a node's distinct series and keeps recording the ones it already has", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const capNodeId = await addNode(db, "cap-node");
		const values = Array.from({ length: MAX_METRICS_SERIES_PER_NODE + 2 }, (_, index) => ({
			name: `cap.${index}`,
			kind: "gauge" as const,
			value: index,
		}));
		store.record(capNodeId, SLOT, values);
		await store.flush();

		const names = await store.seriesNames(capNodeId);
		expect(names).toHaveLength(MAX_METRICS_SERIES_PER_NODE);
		expect(names[0]).toBe("cap.0");
		expect(names).toContain(`cap.${MAX_METRICS_SERIES_PER_NODE - 1}`);
		expect(names).not.toContain(`cap.${MAX_METRICS_SERIES_PER_NODE}`);
		// The over-cap values are logged once, with the limit, not once per value.
		expect(log).toHaveBeenCalledTimes(1);
		expect(String(log.mock.calls[0]?.[0])).toContain(`over the ${MAX_METRICS_SERIES_PER_NODE}-series limit`);

		// With the cap full, an existing series still records and another new name is dropped.
		store.record(capNodeId, SLOT + MINUTE, [
			{ name: "cap.0", kind: "gauge", value: 999 },
			{ name: "cap.over", kind: "gauge", value: 1 },
		]);
		await store.flush();
		expect((await store.seriesNames(capNodeId)).length).toBe(MAX_METRICS_SERIES_PER_NODE);
		expect(await store.seriesNames(capNodeId)).not.toContain("cap.over");
		const readings = await store.read(capNodeId, ["cap.0"], SLOT - MINUTE, SLOT + 2 * MINUTE, 1);
		expect(readings[0]?.buckets.at(-1)?.last).toBe(999);
		// Within the same hour the drop is not logged again.
		expect(log).toHaveBeenCalledTimes(1);
	});

	it("runs a retention sweep queued during a flush after that flush", async () => {
		const sweepNodeId = await addNode(db, "sweep-during-flush");
		let releaseFlush!: () => void;
		const flushGate = new Promise<void>((resolve) => {
			releaseFlush = resolve;
		});
		let enteredFlush!: () => void;
		const flushStarted = new Promise<void>((resolve) => {
			enteredFlush = resolve;
		});
		let hold = true;
		let sweepStarted = false;
		let queriesAfterSweep = 0;
		const plugin: KyselyPlugin = {
			transformQuery(args) {
				if (sweepStarted) queriesAfterSweep += 1;
				return args.node;
			},
			async transformResult(args) {
				if (hold) {
					hold = false;
					enteredFlush();
					await flushGate;
				}
				return args.result;
			},
		};
		const gated = new MetricsStore(db.withPlugin(plugin), { timer: false });
		gated.record(sweepNodeId, SLOT, [{ name: "up", kind: "gauge", value: 1 }]);
		const flushing = gated.flush();
		await flushStarted;
		sweepStarted = true;
		const sweeping = gated.sweep(DEFAULT_METRICS_RETENTION_MS, SLOT + 2 * DAY).then(
			(result) => result,
			(err: unknown) => err,
		);
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			// Serialized: the sweep has not issued a statement while the flush is still open. Without the
			// ordering it would race the flush and could delete the series the flush is creating.
			expect(queriesAfterSweep).toBe(0);
		} finally {
			releaseFlush();
			await flushing;
			await sweeping;
			await gated.close();
		}
	});
});

describe("metrics level chooser", () => {
	const NOW = Date.UTC(2026, 5, 1, 12, 0);
	const retention: MetricsRetentionConfig = {
		l1Ms: 24 * HOUR,
		l2Ms: 7 * DAY,
		l3Ms: 30 * DAY,
		l4Ms: 365 * DAY,
	};
	const choose = (fromMs: number, toMs: number, current = retention) =>
		chooseMetricsLevel({ fromMs, toMs, nowMs: NOW, retention: current });

	it("uses the coarsest level that covers from and still gives 200 points", () => {
		expect(choose(NOW - HOUR, NOW)).toBe(1); // 60 one-minute points; no coarser level reaches 200
		expect(choose(NOW - 24 * HOUR, NOW)).toBe(2); // 288 five-minute points; level 3 gives 24
		expect(choose(NOW - 7 * DAY, NOW)).toBe(2); // 2016 points; level 1 no longer covers from
		expect(choose(NOW - 30 * DAY, NOW)).toBe(3); // 720 hour points, level 4 gives 30
		expect(choose(NOW - 365 * DAY, NOW)).toBe(4); // 365 day points
	});

	it("keeps a boundary range's level despite a few seconds of request skew", () => {
		// A caller computes from/to in the browser a few milliseconds before crhs evaluates the level; the
		// range itself is exactly 24h, 7d, 30d or 365d.
		for (const skew of [50, 5_000]) {
			expect(choose(NOW - HOUR - skew, NOW - skew)).toBe(1);
			expect(choose(NOW - 24 * HOUR - skew, NOW - skew)).toBe(2);
			// Without the tolerance these two fell to levels 3 and 4, because level 2/3 retention is exceeded
			// by the request's few seconds of skew.
			expect(choose(NOW - 7 * DAY - skew, NOW - skew)).toBe(2);
			expect(choose(NOW - 30 * DAY - skew, NOW - skew)).toBe(3);
			expect(choose(NOW - 365 * DAY - skew, NOW - skew)).toBe(4);
		}
	});

	it("falls back to the finest level whose retention covers from", () => {
		// A range of one minute has fewer than 200 points at every level; level 1 still covers from.
		expect(choose(NOW - MINUTE, NOW)).toBe(1);
		// 20 minutes is still fewer than 200 one-minute points.
		expect(choose(NOW - 20 * MINUTE, NOW)).toBe(1);
		// Just under 200 one-minute points, then exactly 200 and 1000 (200 five-minute points).
		expect(choose(NOW - 199 * MINUTE, NOW)).toBe(1);
		expect(choose(NOW - 200 * MINUTE, NOW)).toBe(1);
		expect(choose(NOW - 1000 * MINUTE, NOW)).toBe(2);
	});

	it("takes the retention levels that are set, and the coarsest when none covers from", () => {
		const short = { l1Ms: 2 * HOUR, l2Ms: 2 * HOUR, l3Ms: 2 * HOUR, l4Ms: 2 * HOUR };
		// Ten days back, level 3 covers from and gives 240 hour points; level 4 gives only 10.
		expect(choose(NOW - 10 * DAY, NOW)).toBe(3);
		// With a 2-hour window no level covers a week, so the coarsest is the fallback.
		expect(choose(NOW - 7 * DAY, NOW, short)).toBe(4);
		expect(choose(NOW - 10 * DAY, NOW, short)).toBe(4);
	});

	it("matches the documented defaults", () => {
		expect(DEFAULT_METRICS_RETENTION_MS).toEqual({
			l1Ms: 24 * HOUR,
			l2Ms: 7 * DAY,
			l3Ms: 30 * DAY,
			l4Ms: 365 * DAY,
		});
	});
});

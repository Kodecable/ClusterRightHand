import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { METRIC_LEVEL_BUCKET_MS, type MetricsRetentionConfig } from "../src/metrics/levels.ts";
import { MetricsStore } from "../src/metrics/store.ts";
import { runRetention } from "../src/retention/retention.ts";
import type { Db } from "../src/storage/db.ts";
import { defaultOrgId } from "../src/storage/org.ts";
import { newId } from "../src/util/id.ts";
import { describeBackends, openTestDb } from "./helpers/db.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Aligned to every level's width, so each boundary case can place a bucket exactly at its cutoff. */
const NOW = Date.UTC(2026, 5, 1);

const RETENTION: MetricsRetentionConfig = {
	l1Ms: DAY,
	l2Ms: 7 * DAY,
	l3Ms: 30 * DAY,
	l4Ms: 365 * DAY,
};

async function addNode(db: Db): Promise<string> {
	const id = newId();
	const now = new Date(NOW).toISOString();
	await db
		.insertInto("nodes")
		.values({
			id,
			org_id: await defaultOrgId(db),
			name: `node-${id.slice(-6)}`,
			name_key: `node-${id.slice(-6)}`,
			transport: "client",
			status: "active",
			public_key: null,
			hostname: "node",
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

async function insertSeries(db: Db, nodeId: string, name: string): Promise<string> {
	const id = newId();
	const at = new Date(NOW).toISOString();
	await db
		.insertInto("metric_series")
		.values({ id, node_id: nodeId, name, kind: "gauge", first_seen_at: at, last_seen_at: at })
		.execute();
	return id;
}

async function insertBucket(db: Db, seriesId: string, level: 1 | 2 | 3 | 4, bucketStart: number): Promise<void> {
	await db
		.insertInto("metric_buckets")
		.values({
			series_id: seriesId,
			level,
			bucket_start: bucketStart,
			count: 1,
			sum: 1,
			min: 1,
			max: 1,
			last: 1,
		})
		.execute();
}

async function seriesCount(db: Db): Promise<number> {
	const row = await db
		.selectFrom("metric_series")
		.select((eb) => eb.fn.countAll<number>().as("count"))
		.executeTakeFirstOrThrow();
	return Number(row.count);
}

async function bucketStarts(db: Db, level?: number): Promise<number[]> {
	const query = db.selectFrom("metric_buckets").select("bucket_start").orderBy("bucket_start");
	const rows = level === undefined ? await query.execute() : await query.where("level", "=", level).execute();
	return rows.map((row) => Number(row.bucket_start));
}

describeBackends("metrics retention", (backend) => {
	let db: Db;
	let nodeId: string;
	let store: MetricsStore;

	beforeEach(async () => {
		db = await openTestDb(backend);
		nodeId = await addNode(db);
		store = new MetricsStore(db, { timer: false });
	});
	afterEach(async () => {
		await store.close();
		await db.destroy();
	});

	it("keeps a bucket that ends exactly at the cutoff and deletes one that ended earlier, per level", async () => {
		const seriesId = await insertSeries(db, nodeId, "boundary");
		const survivors: number[] = [];
		const expired: number[] = [];
		for (const level of [1, 2, 3, 4] as const) {
			const size = METRIC_LEVEL_BUCKET_MS[level];
			const cutoff = NOW - RETENTION[`l${level}Ms`];
			// The bucket that ends exactly at the cutoff is kept; the one ending one width earlier is not.
			const keep = cutoff - size;
			const remove = cutoff - 2 * size;
			await insertBucket(db, seriesId, level, keep);
			await insertBucket(db, seriesId, level, remove);
			survivors.push(keep);
			expired.push(remove);
		}

		const swept = await store.sweep(RETENTION, NOW);

		expect(swept).toEqual({ buckets: 4, series: 0 });
		expect(await bucketStarts(db)).toEqual([...survivors].sort((a, b) => a - b));
		for (const start of expired) expect(await bucketStarts(db)).not.toContain(start);
		expect(await seriesCount(db)).toBe(1);
	});

	it("deletes a series once its last bucket is gone and drops it from the id cache", async () => {
		// Every bucket of this sample is older than its level's retention (400 days back covers level 4 too).
		store.record(nodeId, NOW - 400 * DAY, [{ name: "up", kind: "gauge", value: 0 }]);
		await store.flush();
		const old = await db
			.selectFrom("metric_series")
			.select(["id"])
			.where("node_id", "=", nodeId)
			.where("name", "=", "up")
			.executeTakeFirstOrThrow();

		const swept = await store.sweep(RETENTION, NOW);
		expect(swept).toEqual({ buckets: 4, series: 1 });
		expect(await seriesCount(db)).toBe(0);
		expect(await bucketStarts(db)).toEqual([]);

		// The cache entry went with the row: recording the series again creates a new one with a fresh id and
		// its first bucket, instead of writing to a deleted series_id.
		store.record(nodeId, NOW, [{ name: "up", kind: "gauge", value: 1 }]);
		await store.flush();
		const created = await db
			.selectFrom("metric_series")
			.select(["id", "first_seen_at", "last_seen_at"])
			.where("node_id", "=", nodeId)
			.where("name", "=", "up")
			.executeTakeFirstOrThrow();
		expect(created.id).not.toBe(old.id);
		expect(created.first_seen_at).toBe(new Date(NOW).toISOString());
		expect(await bucketStarts(db)).toEqual([NOW, NOW, NOW, NOW]);
	});

	it("deletes in batches until a batch is short", async () => {
		for (let index = 0; index < 5; index++) {
			const seriesId = await insertSeries(db, nodeId, `series-${index}`);
			// Two old level-1 buckets each: retention removes them all, then the series.
			await insertBucket(db, seriesId, 1, NOW - 10 * DAY);
			await insertBucket(db, seriesId, 1, NOW - 10 * DAY + MINUTE);
		}

		const swept = await store.sweep(RETENTION, NOW, { batchSize: 2 });

		expect(swept).toEqual({ buckets: 10, series: 5 });
		expect(await bucketStarts(db)).toEqual([]);
		expect(await seriesCount(db)).toBe(0);
	});

	it("is part of the hourly retention run and its counts", async () => {
		store.record(nodeId, NOW - 400 * DAY, [{ name: "up", kind: "gauge", value: 0 }]);
		await store.flush();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const counts = await runRetention(db, { tasksMs: null, auditMs: null, piTasksMs: null }, new Date(NOW), {
				batchSize: 2,
				metrics: { retention: RETENTION, store },
			});
			expect(counts.metricBuckets).toBe(4);
			expect(counts.metricSeries).toBe(1);
			expect(log).toHaveBeenCalledWith(expect.stringContaining("4 metric bucket(s), 1 metric series"));
		} finally {
			log.mockRestore();
		}
		expect(await seriesCount(db)).toBe(0);
	});

	it("leaves metric tables alone when the run gets no metrics retention", async () => {
		store.record(nodeId, NOW - 400 * DAY, [{ name: "up", kind: "gauge", value: 0 }]);
		await store.flush();

		const counts = await runRetention(db, { tasksMs: null, auditMs: null, piTasksMs: null }, new Date(NOW));

		expect(counts.metricBuckets).toBe(0);
		expect(counts.metricSeries).toBe(0);
		expect(await seriesCount(db)).toBe(1);
		expect(await bucketStarts(db)).toHaveLength(4);
	});

	it("stops between batches when the signal aborts", async () => {
		for (let index = 0; index < 4; index++) {
			const seriesId = await insertSeries(db, nodeId, `abort-${index}`);
			await insertBucket(db, seriesId, 1, NOW - 10 * DAY);
		}
		const aborted = new AbortController();
		aborted.abort();
		const stopped = await store.sweep(RETENTION, NOW, { signal: aborted.signal });
		expect(stopped).toEqual({ buckets: 0, series: 0 });
		expect(await bucketStarts(db)).toHaveLength(4);

		// A signal that turns true after the first batch deletes only that batch.
		let checks = 0;
		const signal = {
			get aborted(): boolean {
				checks++;
				return checks > 1;
			},
		} as unknown as AbortSignal;
		const counts = await store.sweep(RETENTION, NOW, { batchSize: 1, signal });
		expect(counts.buckets).toBe(1);
		expect(await bucketStarts(db)).toHaveLength(3);
	});
});

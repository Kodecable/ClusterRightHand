import { sql } from "kysely";
import type { Db } from "../storage/db.ts";
import {
	METRIC_LEVEL_BUCKET_MS,
	METRIC_LEVELS,
	type MetricLevel,
	type MetricsRetentionConfig,
	retentionMsForLevel,
} from "./levels.ts";

/**
 * Bucket keys read and deleted per batch, so one statement never holds the database queue for long. The
 * same size as the other retention sweeps (retention/retention.ts RETENTION_BATCH_SIZE).
 */
export const METRICS_RETENTION_BATCH_SIZE = 1000;

export interface MetricsRetentionSweepOptions {
	/** Smaller batches for tests; production uses METRICS_RETENTION_BATCH_SIZE. */
	batchSize?: number;
	/** Stops the sweep between batches, so shutdown does not wait out a long run. */
	signal?: AbortSignal;
}

export interface MetricsRetentionSweepResult {
	/** Buckets deleted across all levels. */
	buckets: number;
	/** Series deleted because no bucket was left; the caller drops them from its id cache. */
	seriesIds: string[];
}

/**
 * Deletes metric buckets past their level's retention and the series left without buckets
 * (doc/design/metrics.md "Storage"). A bucket is always whole: its end (`bucket_start + width`) must be
 * older than `now - retention` for it to be deleted, and one that ends exactly at the cutoff is kept.
 *
 * Deletion is batched by composite key, as the other retention sweeps batch by id
 * (doc/design/data-model.md "Retention"). SQLite and PostgreSQL both take a row-value `IN` list, so one
 * statement deletes one batch whatever the dialect.
 */
export async function sweepMetricRetention(
	db: Db,
	retention: MetricsRetentionConfig,
	nowMs: number,
	options: MetricsRetentionSweepOptions = {},
): Promise<MetricsRetentionSweepResult> {
	const batchSize = options.batchSize ?? METRICS_RETENTION_BATCH_SIZE;
	let buckets = 0;
	for (const level of METRIC_LEVELS) {
		const size = METRIC_LEVEL_BUCKET_MS[level];
		// bucket_start + size < now - retention
		const cutoff = nowMs - retentionMsForLevel(retention, level) - size;
		buckets += await deleteBucketsBefore(db, level, cutoff, batchSize, options.signal);
	}
	const seriesIds = await deleteSeriesWithoutBuckets(db, batchSize, options.signal);
	return { buckets, seriesIds };
}

async function deleteBucketsBefore(
	db: Db,
	level: MetricLevel,
	cutoff: number,
	batchSize: number,
	signal: AbortSignal | undefined,
): Promise<number> {
	let deleted = 0;
	while (!signal?.aborted) {
		const rows = await db
			.selectFrom("metric_buckets")
			.select(["series_id", "level", "bucket_start"])
			.where("level", "=", level)
			.where("bucket_start", "<", cutoff)
			.orderBy("bucket_start")
			.limit(batchSize)
			.execute();
		if (rows.length === 0) break;
		const keys = sql.join(
			rows.map((row) => sql`(${row.series_id}, ${row.level}, ${row.bucket_start})`),
			sql`, `,
		);
		const result = await sql`
			delete from metric_buckets
			where (series_id, level, bucket_start) in (${keys})
		`.execute(db);
		const removed = Number(result.numAffectedRows ?? 0);
		deleted += removed;
		// Another process may have deleted the rows between select and delete; stop instead of looping on them.
		if (removed === 0 || rows.length < batchSize) break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return deleted;
}

async function deleteSeriesWithoutBuckets(
	db: Db,
	batchSize: number,
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const deleted: string[] = [];
	while (!signal?.aborted) {
		const rows = await db
			.selectFrom("metric_series")
			.select("id")
			.where((eb) =>
				eb.not(
					eb.exists(
						eb
							.selectFrom("metric_buckets")
							.select(sql`1`.as("one"))
							.whereRef("metric_buckets.series_id", "=", "metric_series.id"),
					),
				),
			)
			.orderBy("id")
			.limit(batchSize)
			.execute();
		if (rows.length === 0) break;
		const ids = rows.map((row) => row.id);
		const result = await db.deleteFrom("metric_series").where("id", "in", ids).executeTakeFirst();
		const removed = Number(result.numDeletedRows);
		if (removed === 0) break;
		deleted.push(...ids);
		if (rows.length < batchSize) break;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return deleted;
}

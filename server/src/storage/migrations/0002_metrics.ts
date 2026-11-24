import { type Kysely, PostgresAdapter, sql } from "kysely";

/**
 * Host metrics (doc/design/metrics.md "Storage"): one row per series of a node, and the aggregated
 * buckets every sampled value is written into.
 *
 * Appended after 0001_initial and never edited (doc/design/compatibility.md "Database"). Self-contained:
 * only Kysely and the dialect check are used, so a later change in the application cannot change what
 * this migration does.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Bucket starts are UTC epoch milliseconds, which pass 2^31: `bigint` on PostgreSQL. SQLite's
	// `integer` is already 64-bit. The pg int8 parser returns numbers (storage/pg-int8.ts).
	const bucketStart = isPostgres(db) ? "bigint" : "integer";
	// count is a small integer (a level-4 bucket holds at most 1440 minute samples); the statistics are
	// floating point so a fractional gauge keeps its value.
	const statistics = isPostgres(db) ? "double precision" : "real";

	await db.schema
		.createTable("metric_series")
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("node_id", "text", (c) => c.notNull().references("nodes.id").onDelete("cascade"))
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("kind", "text", (c) => c.notNull())
		.addColumn("first_seen_at", "text", (c) => c.notNull())
		.addColumn("last_seen_at", "text", (c) => c.notNull())
		.addUniqueConstraint("metric_series_node_name_unique", ["node_id", "name"])
		.addCheckConstraint("metric_series_kind_check", sql`${sql.ref("kind")} in ('gauge', 'delta')`)
		.execute();

	await db.schema
		.createTable("metric_buckets")
		.addColumn("series_id", "text", (c) => c.notNull().references("metric_series.id").onDelete("cascade"))
		.addColumn("level", "integer", (c) => c.notNull())
		.addColumn("bucket_start", bucketStart, (c) => c.notNull())
		.addColumn("count", "integer", (c) => c.notNull())
		.addColumn("sum", statistics, (c) => c.notNull())
		.addColumn("min", statistics, (c) => c.notNull())
		.addColumn("max", statistics, (c) => c.notNull())
		.addColumn("last", statistics, (c) => c.notNull())
		.addPrimaryKeyConstraint("metric_buckets_pk", ["series_id", "level", "bucket_start"])
		.addCheckConstraint("metric_buckets_level_check", sql`${sql.ref("level")} between 1 and 4`)
		.execute();
	// The hourly retention sweep deletes by level and age (doc/design/metrics.md "Storage").
	await db.schema
		.createIndex("metric_buckets_level_bucket_start_idx")
		.on("metric_buckets")
		.columns(["level", "bucket_start"])
		.execute();
}

function isPostgres(db: Kysely<unknown>): boolean {
	return db.getExecutor().adapter instanceof PostgresAdapter;
}

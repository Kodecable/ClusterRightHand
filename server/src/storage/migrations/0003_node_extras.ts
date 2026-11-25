import { type Kysely, PostgresAdapter } from "kysely";

/**
 * The node extras that are not part of the original node row:
 *
 * - `node_traffic`: cumulative traffic totals per node (doc/design/metrics.md "Traffic totals"), the
 *   received and transmitted bytes of the node's current 30-day period, accumulated from the network
 *   deltas the collector computes so the totals survive a crha reboot and a crhs restart.
 * - `nodes.user_remark`: one line an administrator writes on the node's card (doc/design/data-model.md
 *   "Nodes", doc/design/webui.md "Node pages"). Null until the first remark; an empty remark is stored
 *   as null. It is crhs-side content, not a note the node reports.
 * - `nodes.emoji` and `node_groups.emoji`: the optional emoji shown left of the entity's name
 *   (doc/design/webui.md "Node pages"). Null when unset.
 *
 * Appended after 0001_initial and 0002_metrics and never edited (doc/design/compatibility.md
 * "Database"). Self-contained: only Kysely and the dialect check are used.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	// Byte counters are accumulated sums and may be fractional after a restored backup; they are
	// floating point on both dialects, like the bucket statistics in 0002_metrics.
	const bytes = isPostgres(db) ? "double precision" : "real";

	await db.schema
		.createTable("node_traffic")
		// One row per node: the row is created by the first traffic value and deleted with the node.
		.addColumn("node_id", "text", (c) => c.primaryKey().references("nodes.id").onDelete("cascade"))
		.addColumn("period_start", "text", (c) => c.notNull())
		.addColumn("next_reset_at", "text", (c) => c.notNull())
		.addColumn("rx_bytes", bytes, (c) => c.notNull())
		.addColumn("tx_bytes", bytes, (c) => c.notNull())
		.execute();

	// SQLite takes one ADD COLUMN per ALTER TABLE, so each column is added on its own.
	await db.schema.alterTable("nodes").addColumn("user_remark", "text").execute();
	await db.schema.alterTable("nodes").addColumn("emoji", "text").execute();
	await db.schema.alterTable("node_groups").addColumn("emoji", "text").execute();
}

function isPostgres(db: Kysely<unknown>): boolean {
	return db.getExecutor().adapter instanceof PostgresAdapter;
}

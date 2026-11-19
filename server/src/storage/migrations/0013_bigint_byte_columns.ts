import type { Kysely } from "kysely";
import { isPostgres } from "../dialect.ts";

/**
 * Byte counts that can pass 2^31 become `bigint` on PostgreSQL (doc/design/data-model.md "Storage backends").
 * Every listed column counts bytes of input, output, a library or the image cache; a 2 GiB file or
 * output total overflows PostgreSQL's `integer` (int4) and the insert fails. SQLite's `integer` is
 * already a 64-bit value, so it needs no change.
 *
 * Reads return numbers through the int8 type parser (storage/pg-int8.ts): every value stays below 2^53.
 */
const BYTE_COLUMNS: readonly (readonly [table: string, column: string])[] = [
	["tasks", "input_size"],
	["tasks", "max_bytes"],
	["tasks", "output_bytes"],
	["task_groups", "node_max_bytes"],
	["libraries", "max_file_bytes"],
	["libraries", "max_total_bytes"],
	["libraries", "used_bytes"],
	["library_files", "size"],
	["image_cache", "bytes"],
];

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!isPostgres(db)) return;
	for (const [table, column] of BYTE_COLUMNS) {
		await db.schema
			.alterTable(table)
			.alterColumn(column, (c) => c.setDataType("bigint"))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (!isPostgres(db)) return;
	// A value above 2^31 makes this fail loudly rather than truncate a stored size.
	for (const [table, column] of BYTE_COLUMNS) {
		await db.schema
			.alterTable(table)
			.alterColumn(column, (c) => c.setDataType("integer"))
			.execute();
	}
}

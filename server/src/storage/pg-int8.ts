import pg from "pg";

/**
 * PostgreSQL's `pg` driver returns `bigint` (int8) columns as strings, because an int8 may exceed
 * JavaScript's safe integers. Every int8 column in this schema (byte counts, token counts, sequence
 * numbers) stays below 2^53, so one parser makes every read path a number instead of a `Number(...)`
 * conversion at each read site, where a missed one would silently concatenate strings (as
 * `used_bytes + delta` would) or compare them lexically. `doc/design/data-model.md` records the limit.
 *
 * The parser is process-wide (`pg.types` is a single table), so tests that open their own pool call
 * this too; a second call is a no-op.
 */
let configured = false;

export function configurePgInt8AsNumber(): void {
	if (configured) return;
	configured = true;
	pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
}

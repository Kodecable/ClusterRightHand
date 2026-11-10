import { type RawBuilder, type SqlBool, sql } from "kysely";
import { UserError } from "./errors.ts";

/**
 * Keyset cursors for the WebUI's list APIs (doc/design/webui.md "API conventions"): an opaque base64url string holding the
 * descending sort key(s) and the row id, plus the shared `limit` rule. A cursor is never trusted: anything
 * that is not the exact shape this module wrote is a 400, and cursor columns come from code, never the request.
 */

/** The default page size of a cursor list; each endpoint may set another within these bounds. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** Longer than any cursor this module writes; a bigger one is treated as garbage before it is decoded. */
const MAX_CURSOR_LENGTH = 512;
/** Ids and timestamps are short; a longer value in a cursor is garbage. */
const MAX_VALUE_LENGTH = 200;

/** A malformed cursor or limit. A UserError, so the routes' existing 400 handlers answer it. */
export class CursorError extends UserError {}

export type CursorValue = string | number;
export type CursorValueType = "string" | "number";

export interface CursorKey {
	/** The sort columns' values, in the order the spec lists them. */
	readonly values: readonly CursorValue[];
	/** The unique id that breaks ties on the last sort column. */
	readonly id: CursorValue;
}

export interface CursorColumn {
	/** A column reference; a dotted name is a table-qualified one. */
	readonly name: string;
	readonly type: CursorValueType;
}

export interface CursorSpec {
	/** The descending sort columns, excluding the id. Empty when the order is by id alone. */
	readonly columns: readonly CursorColumn[];
	readonly idType: CursorValueType;
	/** The id column; defaults to "id". */
	readonly idColumn?: string;
}

/** `?limit=` (1..200) or the endpoint's default when the parameter is absent. */
export function parseLimit(raw: string | undefined, fallback: number = DEFAULT_LIMIT): number {
	if (raw === undefined) return fallback;
	// Decimal digits only: "1e2" and " 1 " are not page sizes.
	if (!/^\d+$/.test(raw)) throw new CursorError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
	const value = Number(raw);
	if (value < 1 || value > MAX_LIMIT) throw new CursorError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
	return value;
}

/** Encodes one position: base64url JSON `{ "k": [sort values], "id": row id }`. */
export function encodeCursor(values: readonly CursorValue[], id: CursorValue): string {
	return Buffer.from(JSON.stringify({ k: values, id }), "utf8").toString("base64url");
}

/** Decodes and validates a cursor against the endpoint's spec; garbage is a CursorError. */
export function decodeCursor(raw: string, spec: CursorSpec): CursorKey {
	if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
		throw new CursorError("invalid cursor");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		throw new CursorError("invalid cursor");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new CursorError("invalid cursor");
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 2 || !keys.includes("k") || !keys.includes("id")) throw new CursorError("invalid cursor");
	const values = record.k;
	if (!Array.isArray(values) || values.length !== spec.columns.length) throw new CursorError("invalid cursor");
	const decoded = values.map((value, index) => checkValue(value, (spec.columns[index] as CursorColumn).type));
	return { values: decoded, id: checkValue(record.id, spec.idType) };
}

function checkValue(value: unknown, type: CursorValueType): CursorValue {
	if (type === "number") {
		if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new CursorError("invalid cursor");
		return value;
	}
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_VALUE_LENGTH) {
		throw new CursorError("invalid cursor");
	}
	return value;
}

/**
 * The condition that selects rows strictly after a cursor in a descending multi-column order:
 * `(a < x) OR (a = x AND id < y)`, nested for every column. Ties on the sort key therefore neither skip
 * nor repeat rows: the id breaks them. Works on SQLite and PostgreSQL; values are bound, names are code.
 */
export function descendingKeyset(columns: readonly string[], key: CursorKey, idColumn = "id"): RawBuilder<SqlBool> {
	if (columns.length !== key.values.length) throw new CursorError("invalid cursor");
	let condition: RawBuilder<SqlBool> = sql<SqlBool>`${sql.ref(idColumn)} < ${key.id}`;
	for (let index = columns.length - 1; index >= 0; index--) {
		const column = sql.ref(columns[index] as string);
		const value = key.values[index] as CursorValue;
		condition = sql<SqlBool>`(${column} < ${value} OR (${column} = ${value} AND ${condition}))`;
	}
	return condition;
}

/**
 * Runs a query with `limit + 1` rows and turns the page into `{ rows, nextCursor }`: the extra row says
 * whether another page exists, and never leaves the server.
 */
export async function cursorRows<Row>(
	limit: number,
	fetch: (limitPlusOne: number) => Promise<readonly Row[]>,
	cursorOf: (row: Row) => string,
): Promise<{ rows: Row[]; nextCursor: string | null }> {
	const rows = await fetch(limit + 1);
	if (rows.length <= limit) return { rows: [...rows], nextCursor: null };
	const page = rows.slice(0, limit);
	return { rows: page, nextCursor: cursorOf(page[page.length - 1] as Row) };
}

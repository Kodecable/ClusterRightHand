// SQL plumbing and scan helpers of the PostgreSQL port of pi-durable's storage; see index.ts for origin and license.

import type { Cursor, DocumentContent, Id, Page, ScanOrder } from "@earendil-works/pi-durable";
import { StorageRequestError } from "@earendil-works/pi-durable";
import type pg from "pg";

export type TableName = "conversation" | "entry" | "task" | "submission" | "document";
export type Int8 = string | number;
export type RecordIdRow = { readonly record_type: TableName };
export type JsonRow = { readonly record: string };
export type EntryJsonRow = { readonly record: string; readonly commit_seq: Int8 };
export type RevisionRow = {
	readonly seq: Int8;
	readonly kind: DocumentContent["kind"];
	readonly version: Int8;
	readonly content: string;
};
export type IdRow = { readonly id: Int8 };
export type VersionRow = { readonly version: Int8 };
export type MetadataRow = { readonly next_id: Int8; readonly next_seq: Int8 };
export type SqlValue = null | number | string;

/** What both `pg.Pool` and a checked-out client offer. */
export interface Executor {
	query<R extends pg.QueryResultRow>(text: string, values?: SqlValue[]): Promise<pg.QueryResult<R>>;
}

export const parseJson = <T>(value: string): T => JSON.parse(value) as T;
export const encodeJson = (value: unknown): string => JSON.stringify(value) as string;
// PostgreSQL TEXT cannot hold lone UTF-16 surrogates or NUL. JSON encoding keeps indexed identities lossless.
export const encodeIndexedString = (value: string): string => JSON.stringify(value);

/** int8 columns arrive as strings; every ID and sequence stays within JavaScript's safe integers. */
export const toInt = (value: Int8): number => {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) throw new Error(`Durable PostgreSQL value ${value} is not a safe integer`);
	return number;
};

// The SQL below is written with SQLite's `?` placeholders, as in the original; this renders PostgreSQL's `$n`.
const renderedSql = new Map<string, string>();
export const pgSql = (sql: string): string => {
	let rendered = renderedSql.get(sql);
	if (rendered === undefined) {
		let index = 0;
		rendered = sql.replace(/\?/g, () => `$${++index}`);
		renderedSql.set(sql, rendered);
	}
	return rendered;
};

export async function getRow<T extends pg.QueryResultRow>(
	executor: Executor,
	sql: string,
	...params: SqlValue[]
): Promise<T | undefined> {
	return (await executor.query<T>(pgSql(sql), params)).rows[0];
}

export async function allRows<T extends pg.QueryResultRow>(
	executor: Executor,
	sql: string,
	...params: SqlValue[]
): Promise<T[]> {
	return (await executor.query<T>(pgSql(sql), params)).rows;
}

export async function run(executor: Executor, sql: string, ...params: SqlValue[]): Promise<void> {
	await executor.query(pgSql(sql), params);
}

/** Run `callback` in one transaction on a dedicated pooled client, rolling back when it rejects. */
export async function inTransaction<T>(
	pool: pg.Pool,
	begin: string,
	callback: (client: pg.PoolClient) => Promise<T>,
	afterCommit?: (value: T) => void,
): Promise<T> {
	const client = await pool.connect();
	let broken: Error | undefined;
	try {
		await client.query(begin);
		let value: T;
		try {
			value = await callback(client);
			await client.query("COMMIT");
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch (rollbackError) {
				broken = rollbackError as Error;
				throw new AggregateError([error, rollbackError], "Durable PostgreSQL transaction failed to roll back");
			}
			throw error;
		}
		// Synchronously after COMMIT succeeded, before the caller's queue lets another transaction start.
		afterCommit?.(value);
		return value;
	} finally {
		client.release(broken);
	}
}

export const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	return after as I;
};

/** Where a built-in storage scan starts; mirrors pi-durable's internal `storage/scan.ts`. */
export type ScanStart = { readonly order: ScanOrder; readonly after: number | undefined };

export function scanStart(
	requested: ScanOrder | undefined,
	cursor: Readonly<Record<string, unknown>> | undefined,
	fallback: ScanOrder,
): ScanStart {
	if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
		throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
	}
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
		throw new StorageRequestError("Invalid storage cursor");
	}
	const order = (stored as ScanOrder | undefined) ?? fallback;
	if (requested !== undefined && requested !== order) {
		throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	}
	return { order, after };
}

const nextCursor = (id: Id<string>, order: ScanOrder): Cursor => ({ after: id, order });

export const page = <T extends { readonly id: Id<string> }>(
	values: readonly T[],
	limit: number,
	order: ScanOrder = "ascending",
): Page<T, Cursor> => {
	const items = values.slice(0, limit);
	const last = items.at(-1);
	if (values.length <= limit || last === undefined) return { items };
	return { items, next: nextCursor(last.id, order) };
};

/** The ID condition, its parameter, and the `ORDER BY` direction of a table scan. */
export const scanSql = (
	start: ScanStart,
): { readonly clause: string; readonly param: number; readonly direction: string } =>
	start.order === "ascending"
		? { clause: "id > ?", param: start.after ?? -1, direction: "ASC" }
		: { clause: "id < ?", param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" };

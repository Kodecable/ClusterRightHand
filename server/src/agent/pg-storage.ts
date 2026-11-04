// PostgreSQL storage backend for pi-durable.
//
// Ported from pi-durable 1.4.0 `packages/durable/src/storage/sqlite/storage.ts` (with its `migrations.ts` and
// `schema.ts`), https://github.com/earendil-works/pi-mono, used under the MIT License:
//
//   Copyright (c) 2025 Mario Zechner
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
//   the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
//   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
//   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.
//
// Differences from the SQLite original:
// - Tables live in one PostgreSQL schema (`options.schema`, default: the pool's `current_schema()`), every table and
//   index name carries `options.prefix` (default `pi_`). Records stay TEXT holding JSON, so they round-trip exactly
//   (JSONB would reject lone-surrogate escapes and reorder keys).
// - The schema history starts at version 1 with the final SQLite layout (including the `sleeping` task status).
// - `open()` takes a session-level advisory lock on a dedicated connection; a second owner is refused.
// - Commits are serialized in-process and each runs in its own transaction on a pooled client; reads use the pool and
//   observe every batch whose commit has resolved. `document()` reads in one REPEATABLE READ snapshot.
// - The pool belongs to the caller: `close()` releases the lock connection but does not end the pool.

import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import {
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	type DocumentAddress,
	type DocumentContent,
	type DocumentCreate,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Id,
	type JsonObject,
	type Page,
	type ScanOrder,
	type Seq,
	type Storage,
	StorageRequestError,
	type StorageWrite,
	type StoredDocument,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskQuery,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import pg from "pg";

type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type TableName = "conversation" | "entry" | "task" | "submission" | "document";
type Int8 = string | number;
type RecordIdRow = { readonly record_type: TableName };
type JsonRow = { readonly record: string };
type EntryJsonRow = { readonly record: string; readonly commit_seq: Int8 };
type RevisionRow = {
	readonly seq: Int8;
	readonly kind: DocumentContent["kind"];
	readonly version: Int8;
	readonly content: string;
};
type IdRow = { readonly id: Int8 };
type VersionRow = { readonly version: Int8 };
type MetadataRow = { readonly next_id: Int8; readonly next_seq: Int8 };
type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};
type ScopeColumns = {
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
};
type SqlValue = null | number | string;

/** What both `pg.Pool` and a checked-out client offer. */
interface Executor {
	query<R extends pg.QueryResultRow>(text: string, values?: SqlValue[]): Promise<pg.QueryResult<R>>;
}

export type PgStorageOptions = {
	/**
	 * Prefix for every table and index. Letters, digits and underscores, not starting with a digit, short enough that
	 * every name fits PostgreSQL's 63-byte identifier limit. Existing data is not migrated when this changes.
	 */
	readonly prefix?: string;
	/** PostgreSQL schema holding the tables; it must exist. Default: `current_schema()` of the pool's connections. */
	readonly schema?: string;
};

export const DEFAULT_PG_STORAGE_PREFIX = "pi_";

/**
 * Immutable identifier history, as in the SQLite schema. Never change or remove an existing value; a rename adds a new
 * entry so historical migrations keep rendering their original object names.
 */
const TABLE_NAMES = {
	durableSchema: "durable_schema",
	durableMetadata: "durable_metadata",
	recordIds: "record_ids",
	conversations: "conversations",
	entries: "entries",
	tasks: "tasks",
	submissions: "submissions",
	documents: "documents",
	documentRevisions: "document_revisions",
} as const;

const INDEX_NAMES = {
	conversationsByOwnerConversation: "conversations_by_owner_conversation",
	conversationsByOwnerTask: "conversations_by_owner_task",
	entriesByConversation: "entries_by_conversation",
	entryHeadsByConversation: "entry_heads_by_conversation",
	tasksByStatus: "tasks_by_status",
	tasksByConversation: "tasks_by_conversation",
	tasksByKind: "tasks_by_kind",
	tasksByAbortRequested: "tasks_by_abort_requested",
	tasksByBackground: "tasks_by_background",
	submissionsByRequest: "submissions_by_request",
	submissionsByConversation: "submissions_by_conversation",
	submissionsByStatus: "submissions_by_status",
	documentsByAddress: "documents_by_address",
	documentsByScope: "documents_by_scope",
	documentsByScopeKind: "documents_by_scope_kind",
	documentRevisionsByKind: "document_revisions_by_kind",
} as const;

type Identifiers<T extends Record<string, string>> = { readonly [K in keyof T]: string };

type PgSchema = {
	/** Schema-qualified, quoted table names. */
	readonly tables: Identifiers<typeof TABLE_NAMES>;
	/** Quoted index names (an index always lives in its table's schema). */
	readonly indexes: Identifiers<typeof INDEX_NAMES>;
};

const MAX_IDENTIFIER_BYTES = 63;
const LONGEST_NAME = Math.max(...[...Object.values(TABLE_NAMES), ...Object.values(INDEX_NAMES)].map((n) => n.length));

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function validatePrefix(prefix: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
		throw new Error(`Invalid PgStorage prefix ${JSON.stringify(prefix)}: use letters, digits and underscores`);
	}
	if (prefix.length + LONGEST_NAME > MAX_IDENTIFIER_BYTES) {
		throw new Error(`PgStorage prefix ${JSON.stringify(prefix)} is too long`);
	}
}

function createSchema(schema: string, prefix: string): PgSchema {
	const qualify = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(prefix + name)}`;
	return {
		tables: Object.fromEntries(Object.entries(TABLE_NAMES).map(([key, name]) => [key, qualify(name)])) as Identifiers<
			typeof TABLE_NAMES
		>,
		indexes: Object.fromEntries(
			Object.entries(INDEX_NAMES).map(([key, name]) => [key, quoteIdentifier(prefix + name)]),
		) as Identifiers<typeof INDEX_NAMES>,
	};
}

type Migration = { readonly version: number; readonly statements: readonly string[] };

/** Ordered schema history. Version 1 is the SQLite schema at pi-durable 1.4.0 (SQLite version 2) in PostgreSQL. */
function createMigrations(schema: PgSchema): readonly Migration[] {
	const { tables, indexes } = schema;
	const initialSchema: readonly string[] = [
		`CREATE TABLE ${tables.durableMetadata} (
			singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
			next_id BIGINT NOT NULL,
			next_seq BIGINT NOT NULL
		)`,
		`INSERT INTO ${tables.durableMetadata} (singleton, next_id, next_seq) VALUES (1, 2, 1)`,
		`CREATE TABLE ${tables.recordIds} (
			id BIGINT PRIMARY KEY,
			record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
		)`,
		`CREATE TABLE ${tables.conversations} (
			id BIGINT PRIMARY KEY,
			owner_conversation_id BIGINT,
			owner_task_id BIGINT,
			record TEXT NOT NULL
		)`,
		`CREATE INDEX ${indexes.conversationsByOwnerConversation} ON ${tables.conversations} (owner_conversation_id, id)`,
		`CREATE INDEX ${indexes.conversationsByOwnerTask} ON ${tables.conversations} (owner_task_id, id)`,
		`CREATE TABLE ${tables.entries} (
			id BIGINT PRIMARY KEY,
			conversation_id BIGINT NOT NULL,
			head BIGINT,
			commit_seq BIGINT NOT NULL,
			record TEXT NOT NULL
		)`,
		`CREATE INDEX ${indexes.entriesByConversation} ON ${tables.entries} (conversation_id, id DESC)`,
		`CREATE INDEX ${indexes.entryHeadsByConversation} ON ${tables.entries} (conversation_id, id DESC) WHERE head IS NOT NULL`,
		`CREATE TABLE ${tables.tasks} (
			id BIGINT PRIMARY KEY,
			conversation_id BIGINT NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
			abort_requested SMALLINT NOT NULL CHECK (abort_requested IN (0, 1)),
			background SMALLINT NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL
		)`,
		`CREATE INDEX ${indexes.tasksByStatus} ON ${tables.tasks} (status, id)`,
		`CREATE INDEX ${indexes.tasksByConversation} ON ${tables.tasks} (conversation_id, id)`,
		`CREATE INDEX ${indexes.tasksByKind} ON ${tables.tasks} (kind, id)`,
		`CREATE INDEX ${indexes.tasksByAbortRequested} ON ${tables.tasks} (abort_requested, id)`,
		`CREATE INDEX ${indexes.tasksByBackground} ON ${tables.tasks} (background, id)`,
		`CREATE TABLE ${tables.submissions} (
			id BIGINT PRIMARY KEY,
			conversation_id BIGINT NOT NULL,
			request_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
			record TEXT NOT NULL
		)`,
		`CREATE INDEX ${indexes.submissionsByRequest} ON ${tables.submissions} (conversation_id, request_id)`,
		`CREATE INDEX ${indexes.submissionsByConversation} ON ${tables.submissions} (conversation_id, id)`,
		`CREATE INDEX ${indexes.submissionsByStatus} ON ${tables.submissions} (status, id)`,
		`CREATE TABLE ${tables.documents} (
			id BIGINT PRIMARY KEY,
			kind TEXT NOT NULL,
			family SMALLINT NOT NULL CHECK (family IN (0, 1)),
			key_value TEXT NOT NULL,
			scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
			owner_id BIGINT NOT NULL,
			created_at BIGINT NOT NULL,
			retired_at BIGINT,
			record TEXT NOT NULL
		)`,
		`CREATE INDEX ${indexes.documentsByAddress}
			ON ${tables.documents} (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
		`CREATE INDEX ${indexes.documentsByScope} ON ${tables.documents} (scope_kind, owner_id, id)`,
		`CREATE INDEX ${indexes.documentsByScopeKind} ON ${tables.documents} (scope_kind, owner_id, kind, id)`,
		`CREATE TABLE ${tables.documentRevisions} (
			document_id BIGINT NOT NULL,
			seq BIGINT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
			version BIGINT NOT NULL,
			content TEXT NOT NULL,
			PRIMARY KEY (document_id, seq)
		)`,
		`CREATE INDEX ${indexes.documentRevisionsByKind} ON ${tables.documentRevisions} (document_id, kind, seq DESC)`,
	];
	return [{ version: 1, statements: initialSchema }];
}

/** A signed 64-bit advisory lock key for one purpose on one (schema, prefix) pair. */
function advisoryKey(purpose: string, schema: string, prefix: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify(["pi-durable", purpose, schema, prefix]))
		.digest();
	return digest.readBigInt64BE(0).toString();
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const encodeJson = (value: unknown): string => JSON.stringify(value) as string;
// PostgreSQL TEXT cannot hold lone UTF-16 surrogates or NUL. JSON encoding keeps indexed identities lossless.
const encodeIndexedString = (value: string): string => JSON.stringify(value);

/** int8 columns arrive as strings; every ID and sequence stays within JavaScript's safe integers. */
const toInt = (value: Int8): number => {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) throw new Error(`Durable PostgreSQL value ${value} is not a safe integer`);
	return number;
};

// The SQL below is written with SQLite's `?` placeholders, as in the original; this renders PostgreSQL's `$n`.
const renderedSql = new Map<string, string>();
const pgSql = (sql: string): string => {
	let rendered = renderedSql.get(sql);
	if (rendered === undefined) {
		let index = 0;
		rendered = sql.replace(/\?/g, () => `$${++index}`);
		renderedSql.set(sql, rendered);
	}
	return rendered;
};

async function getRow<T extends pg.QueryResultRow>(
	executor: Executor,
	sql: string,
	...params: SqlValue[]
): Promise<T | undefined> {
	return (await executor.query<T>(pgSql(sql), params)).rows[0];
}

async function allRows<T extends pg.QueryResultRow>(
	executor: Executor,
	sql: string,
	...params: SqlValue[]
): Promise<T[]> {
	return (await executor.query<T>(pgSql(sql), params)).rows;
}

async function run(executor: Executor, sql: string, ...params: SqlValue[]): Promise<void> {
	await executor.query(pgSql(sql), params);
}

/** Run `callback` in one transaction on a dedicated pooled client, rolling back when it rejects. */
async function inTransaction<T>(
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

async function applyMigrations(
	pool: pg.Pool,
	schema: PgSchema,
	migrations: readonly Migration[],
	lockKey: string,
): Promise<void> {
	const table = schema.tables.durableSchema;
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("PostgreSQL migrations must have contiguous versions starting at 1");
		}
	}
	await inTransaction(pool, "BEGIN", async (client) => {
		await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey]);
		await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
			singleton SMALLINT PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		)`);
		await run(client, `INSERT INTO ${table} (singleton, version) VALUES (1, 0) ON CONFLICT DO NOTHING`);
		const row = await getRow<VersionRow>(client, `SELECT version FROM ${table} WHERE singleton = 1 FOR UPDATE`);
		if (row === undefined) throw new Error("Durable PostgreSQL schema metadata is missing");
		const version = toInt(row.version);
		const currentVersion = migrations.at(-1)?.version ?? 0;
		if (version > currentVersion) {
			throw new Error(`Durable PostgreSQL schema version ${version} is newer than supported version ${currentVersion}`);
		}
		for (const migration of migrations) {
			if (migration.version <= version) continue;
			for (const statement of migration.statements) await client.query(statement);
			await run(client, `UPDATE ${table} SET version = ? WHERE singleton = 1`, migration.version);
		}
	});
}

const cursorId = <I extends Id<string>>(cursor: Cursor | undefined): I | undefined => {
	const after = cursor?.after;
	if (after === undefined) return undefined;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	return after as I;
};

/** Where a built-in storage scan starts; mirrors pi-durable's internal `storage/scan.ts`. */
type ScanStart = { readonly order: ScanOrder; readonly after: number | undefined };

function scanStart(
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

const page = <T extends { readonly id: Id<string> }>(
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
const scanSql = (start: ScanStart): { readonly clause: string; readonly param: number; readonly direction: string } =>
	start.order === "ascending"
		? { clause: "id > ?", param: start.after ?? -1, direction: "ASC" }
		: { clause: "id < ?", param: start.after ?? Number.MAX_SAFE_INTEGER, direction: "DESC" };

const scopeColumns = (scope: DocumentRecord["scope"]): ScopeColumns => {
	switch (scope.kind) {
		case "session":
			return { scopeKind: "session", ownerId: 0 };
		case "conversation":
			return { scopeKind: "conversation", ownerId: scope.conversationId };
		case "task":
			return { scopeKind: "task", ownerId: scope.taskId };
	}
};

const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ""),
	};
};

const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

const writeId = (write: StorageWrite): Id<string> | undefined => {
	switch (write.type) {
		case "conversation":
		case "entry":
		case "task":
		case "submission":
			return write.value.id;
		case "document.create":
		case "document.copy":
			return write.record.id;
		case "document.change":
		case "document.retire":
			return undefined;
	}
};

/** PostgreSQL implementation of the pi-durable storage contract; one process owns a (schema, prefix) at a time. */
export class PgStorage implements Storage {
	private readonly pool: pg.Pool;
	private readonly lockClient: pg.Client;
	private readonly lockKey: string;
	private readonly schema: PgSchema;
	private nextId: number;
	private closed = false;
	private closing: Promise<void> | undefined;
	private lockLost: Error | undefined;
	/** Settles when the previous commit has settled; commits run strictly one after another. */
	private commitTail: Promise<unknown> = Promise.resolve();
	private admitted = 0;
	private drained: (() => void) | undefined;

	private constructor(pool: pg.Pool, lockClient: pg.Client, lockKey: string, schema: PgSchema, nextId: number) {
		this.pool = pool;
		this.lockClient = lockClient;
		this.lockKey = lockKey;
		this.schema = schema;
		this.nextId = nextId;
		lockClient.on("error", (error) => {
			// The session-level lock died with its connection; another process may now own the storage.
			this.lockLost = error;
		});
	}

	/**
	 * Take ownership of the storage at (schema, prefix), migrate it, and load its ID counter. The pool stays owned by
	 * the caller; one extra connection with the pool's settings holds the ownership lock until `close()`.
	 */
	static async open(pool: pg.Pool, options: PgStorageOptions = {}): Promise<PgStorage> {
		const prefix = options.prefix ?? DEFAULT_PG_STORAGE_PREFIX;
		validatePrefix(prefix);
		const lockClient = new pg.Client(pool.options);
		lockClient.on("error", () => {
			// Reported by the failing query during open; the instance installs its own handler afterwards.
		});
		try {
			await lockClient.connect();
			let schemaName = options.schema;
			if (schemaName === undefined) {
				const { rows } = await lockClient.query<{ schema: string | null }>("SELECT current_schema() AS schema");
				schemaName = rows[0]?.schema ?? undefined;
				if (schemaName === undefined) throw new Error("PgStorage: the connection has no current schema");
			}
			const lockKey = advisoryKey("owner", schemaName, prefix);
			const { rows } = await lockClient.query<{ locked: boolean }>(
				"SELECT pg_try_advisory_lock($1::bigint) AS locked",
				[lockKey],
			);
			if (rows[0]?.locked !== true) {
				throw new Error(
					`PgStorage: storage ${JSON.stringify(`${schemaName}.${prefix}*`)} is already open in another session ` +
						"(advisory lock held); only one process may own it",
				);
			}
			const schema = createSchema(schemaName, prefix);
			await applyMigrations(pool, schema, createMigrations(schema), advisoryKey("migrate", schemaName, prefix));
			await PgStorage.ensureEntryCompression(pool, schema);
			const metadata = await getRow<MetadataRow>(
				pool,
				`SELECT next_id, next_seq FROM ${schema.tables.durableMetadata} WHERE singleton = 1`,
			);
			if (metadata === undefined) throw new Error("Durable PostgreSQL metadata is missing");
			lockClient.removeAllListeners("error");
			return new PgStorage(pool, lockClient, lockKey, schema, Number(metadata.next_id));
		} catch (error) {
			try {
				await lockClient.end(); // also releases the session-level lock
			} catch {
				// Preserve the initialization failure.
			}
			throw error;
		}
	}

	/**
	 * Give `pi_entries.record` lz4 column compression. Checked on every open, not in a versioned migration: a
	 * migration skipped before a PostgreSQL upgrade would never run again. Only values written afterwards are
	 * compressed, and only rows past the ~2 KB TOAST threshold are actually TOASTed; existing rows keep their
	 * compression. A server without the feature is a warning, not an error.
	 */
	private static async ensureEntryCompression(pool: pg.Pool, schema: PgSchema): Promise<void> {
		const entries = schema.tables.entries;
		const { rows } = await pool.query<{ version: string }>("SELECT current_setting('server_version_num') AS version");
		const version = rows[0]?.version;
		if (!(Number(version) >= 140000)) {
			console.warn(
				`PgStorage: PostgreSQL ${version ?? "unknown"} has no column compression; ${entries}.record stays ` +
					"without lz4 compression (it needs PostgreSQL 14 or newer)",
			);
			return;
		}
		const { rows: columns } = await pool.query<{ attcompression: string }>(
			"SELECT a.attcompression FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attname = 'record'",
			[entries],
		);
		if (columns[0]?.attcompression === "l") return;
		try {
			await pool.query(`ALTER TABLE ${entries} ALTER COLUMN record SET COMPRESSION lz4`);
		} catch (error) {
			if (!(error instanceof pg.DatabaseError && error.code === "0A000")) throw error;
			console.warn(
				`PgStorage: this PostgreSQL build does not support lz4 compression (${error.message}); ` +
					`${entries}.record stays without lz4 compression`,
			);
		}
	}

	commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
		return this.admit(() => {
			const result = this.commitTail.then(() => this.commitNow(writes));
			this.commitTail = result.catch(() => undefined);
			return result;
		});
	}

	/** Runs once the previous commit settled; a commit admitted before `close()` still runs, as on SQLite. */
	private async commitNow(writes: readonly StorageWrite[]): Promise<Seq> {
		this.assertOwned();
		const documentActions = this.prepareDocumentActions(writes);
		const candidateNextId = this.candidateNextId(writes);
		return inTransaction(
			this.pool,
			"BEGIN",
			async (transaction) => {
				const metadata = await getRow<MetadataRow>(
					transaction,
					`SELECT next_id, next_seq FROM ${this.schema.tables.durableMetadata} WHERE singleton = 1 FOR UPDATE`,
				);
				if (metadata === undefined) throw new Error("Durable PostgreSQL metadata is missing");
				const committedSeq = toInt(metadata.next_seq) as Seq;
				await this.checkGlobalIds(transaction, writes);
				await this.checkDocumentActions(transaction, documentActions);
				for (const write of writes) await this.applyTableWrite(transaction, write, committedSeq);
				await this.applyDocumentActions(transaction, documentActions, committedSeq);
				await run(
					transaction,
					`UPDATE ${this.schema.tables.durableMetadata} SET next_id = ?, next_seq = ? WHERE singleton = 1`,
					Math.max(Number(metadata.next_id), candidateNextId),
					committedSeq + 1,
				);
				return committedSeq;
			},
			() => {
				this.nextId = Math.max(this.nextId, candidateNextId);
			},
		);
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++ as I;
	}

	conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		return this.admit(() => this.readConversation(id));
	}

	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.admit(async () => {
			const start = scanStart(query.order, cursor, "ascending");
			const scan = scanSql(start);
			const clauses = [scan.clause];
			const params: SqlValue[] = [scan.param];
			if (query.ownerConversationId !== undefined) {
				clauses.push("owner_conversation_id = ?");
				params.push(query.ownerConversationId);
			}
			if (query.ownerTaskId !== undefined) {
				clauses.push("owner_task_id = ?");
				params.push(query.ownerTaskId);
			}
			params.push(limit + 1);
			const rows = await allRows<JsonRow>(
				this.pool,
				`SELECT record FROM ${this.schema.tables.conversations} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
				...params,
			);
			return page(
				rows.map((row) => parseJson<ConversationRecord>(row.record)),
				limit,
				start.order,
			);
		});
	}

	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	entry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		return this.admit(() => this.readEntry(idOrConversationId, idOrContext, context));
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.admit(() => this.readLatestHeadMarker(conversationId, atOrBeforeEntryId));
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.admit(() => this.readEntries(query, limit, cursor));
	}

	private async readEntry(
		idOrConversationId: EntryId | ConversationId,
		idOrContext: EntryId | Context,
		context?: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
		const id =
			context === undefined
				? (idOrConversationId as number as EntryId)
				: typeof idOrContext === "number"
					? (idOrContext as EntryId)
					: undefined;
		if (id === undefined) throw new StorageRequestError("Storage.entry() requires an entry ID");
		let conversation: ConversationRecord | undefined;
		if (context !== undefined) {
			const conversationId = idOrConversationId as number as ConversationId;
			conversation = await this.readConversation(conversationId);
			if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		}
		const row = await getRow<EntryJsonRow>(
			this.pool,
			`SELECT record, commit_seq FROM ${this.schema.tables.entries} WHERE id = ?`,
			id,
		);
		if (row === undefined) return undefined;
		const entry = parseJson<EntryRecord>(row.record);
		if (conversation !== undefined) {
			let upperEntryId = Number.POSITIVE_INFINITY;
			while (conversation.id !== entry.conversationId) {
				if (conversation.parent === undefined) return undefined;
				upperEntryId = Math.min(upperEntryId, conversation.parent.at);
				conversation = await this.readAncestor(conversation.parent.conversationId);
			}
			if (entry.id > upperEntryId) return undefined;
		}
		return { entry, commitSeq: toInt(row.commit_seq) as Seq };
	}

	private async readLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		let conversation = await this.readConversation(conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
		let upper: number | undefined = atOrBeforeEntryId;
		while (true) {
			const row =
				upper === undefined
					? await getRow<JsonRow>(
							this.pool,
							`SELECT record FROM ${this.schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1`,
							conversation.id,
						)
					: await getRow<JsonRow>(
							this.pool,
							`SELECT record FROM ${this.schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1`,
							conversation.id,
							upper,
						);
			if (row !== undefined) return parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
			if (conversation.parent === undefined) return undefined;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			conversation = await this.readAncestor(conversation.parent.conversationId);
		}
	}

	private async readEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		const { order, after } = scanStart(query.order, cursor, "descending");
		if (order === "ascending") return this.readEntriesAscending(query, limit, after);
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		if (after !== undefined) upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
		const values: EntryRecord[] = [];
		while (true) {
			const clauses = ["conversation_id = ?"];
			const params: SqlValue[] = [conversation.id];
			if (query.minEntryId !== undefined) {
				clauses.push("id >= ?");
				params.push(query.minEntryId);
			}
			if (upper !== undefined) {
				clauses.push("id <= ?");
				params.push(upper);
			}
			params.push(limit + 1 - values.length);
			const rows = await allRows<JsonRow>(
				this.pool,
				`SELECT record FROM ${this.schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
				...params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			if (values.length > limit || conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = await this.readAncestor(conversation.parent.conversationId);
		}
		return page(values, limit, "descending");
	}

	/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
	private async readEntriesAscending(
		query: EntryQuery,
		limit: number,
		after: number | undefined,
	): Promise<Page<EntryRecord, Cursor>> {
		const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
		let conversation = await this.readConversation(query.conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
		let upper: number | undefined = query.maxEntryId;
		while (true) {
			segments.push({ conversationId: conversation.id, upper });
			if (conversation.parent === undefined) break;
			upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
			if (query.minEntryId !== undefined && upper < query.minEntryId) break;
			conversation = await this.readAncestor(conversation.parent.conversationId);
		}
		let lower: number | undefined = query.minEntryId;
		if (after !== undefined) lower = Math.max(lower ?? after + 1, after + 1);
		const values: EntryRecord[] = [];
		for (const segment of segments.reverse()) {
			const clauses = ["conversation_id = ?"];
			const params: SqlValue[] = [segment.conversationId];
			if (lower !== undefined) {
				clauses.push("id >= ?");
				params.push(lower);
			}
			if (segment.upper !== undefined) {
				clauses.push("id <= ?");
				params.push(segment.upper);
			}
			params.push(limit + 1 - values.length);
			const rows = await allRows<JsonRow>(
				this.pool,
				`SELECT record FROM ${this.schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`,
				...params,
			);
			values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
			if (values.length > limit) break;
		}
		return page(values, limit, "ascending");
	}

	task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		return this.admit(async () => {
			const row = await getRow<JsonRow>(this.pool, `SELECT record FROM ${this.schema.tables.tasks} WHERE id = ?`, id);
			return row === undefined ? undefined : parseJson<StoredTask>(row.record);
		});
	}

	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		return this.admit(async () => {
			const start = scanStart(query.order, cursor, "ascending");
			const scan = scanSql(start);
			const clauses = [scan.clause];
			const params: SqlValue[] = [scan.param];
			if (query.conversationId !== undefined) {
				clauses.push("conversation_id = ?");
				params.push(query.conversationId);
			}
			if (query.kind !== undefined) {
				clauses.push("kind = ?");
				params.push(encodeIndexedString(query.kind));
			}
			if (query.status !== undefined) {
				clauses.push("status = ?");
				params.push(query.status);
			}
			if (query.abortRequested !== undefined) {
				clauses.push("abort_requested = ?");
				params.push(query.abortRequested ? 1 : 0);
			}
			if (query.background !== undefined) {
				clauses.push("background = ?");
				params.push(query.background ? 1 : 0);
			}
			params.push(limit + 1);
			const rows = await allRows<JsonRow>(
				this.pool,
				`SELECT record FROM ${this.schema.tables.tasks} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
				...params,
			);
			return page(
				rows.map((row) => parseJson<StoredTask>(row.record)),
				limit,
				start.order,
			);
		});
	}

	submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		return this.admit(async () => {
			const row = await getRow<JsonRow>(
				this.pool,
				`SELECT record FROM ${this.schema.tables.submissions} WHERE id = ?`,
				id,
			);
			return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
		});
	}

	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.admit(async () => {
			const start = scanStart(query.order, cursor, "ascending");
			const scan = scanSql(start);
			const clauses = [scan.clause];
			const params: SqlValue[] = [scan.param];
			if (query.conversationId !== undefined) {
				clauses.push("conversation_id = ?");
				params.push(query.conversationId);
			}
			if (query.status !== undefined) {
				clauses.push("status = ?");
				params.push(query.status);
			}
			params.push(limit + 1);
			const rows = await allRows<JsonRow>(
				this.pool,
				`SELECT record FROM ${this.schema.tables.submissions} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
				...params,
			);
			return page(
				rows.map((row) => parseJson<SubmissionRecord>(row.record)),
				limit,
				start.order,
			);
		});
	}

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.admit(async () => {
			const row = await getRow<JsonRow>(
				this.pool,
				`SELECT record FROM ${this.schema.tables.submissions} WHERE conversation_id = ? AND request_id = ?`,
				conversationId,
				encodeIndexedString(requestId),
			);
			return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
		});
	}

	findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
		return this.admit(async () => {
			const parts = addressParts(address);
			const sql =
				at === "current"
					? `SELECT record FROM ${this.schema.tables.documents}
						WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
						AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
					: `SELECT record FROM ${this.schema.tables.documents}
						WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
						AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
						ORDER BY created_at DESC LIMIT 1`;
			const params: SqlValue[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
			if (at !== "current") params.push(at, at);
			const row = await getRow<JsonRow>(this.pool, sql, ...params);
			return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
		});
	}

	document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		// The record and revision queries must observe one committed state; a commit between them can replace the base.
		return this.admit(() =>
			inTransaction(this.pool, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", (transaction) =>
				this.materializeDocument(transaction, id, at),
			),
		);
	}

	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.admit(async () => {
			const scope = scopeColumns(query.scope);
			const clauses = ["scope_kind = ?", "owner_id = ?", "id > ?"];
			const params: SqlValue[] = [scope.scopeKind, scope.ownerId, cursorId(cursor) ?? -1];
			if (query.kind !== undefined) {
				clauses.push("kind = ?");
				params.push(encodeIndexedString(query.kind));
			}
			if (query.at === "current") {
				clauses.push("retired_at IS NULL");
			} else {
				clauses.push("created_at <= ?", "(retired_at IS NULL OR retired_at > ?)");
				params.push(query.at, query.at);
			}
			params.push(limit + 1);
			const rows = await allRows<JsonRow>(
				this.pool,
				`SELECT record FROM ${this.schema.tables.documents} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
				...params,
			);
			return page(
				rows.map((row) => parseJson<DocumentRecord>(row.record)),
				limit,
			);
		});
	}

	/** Reject new operations, wait for admitted ones (commits included), then release the ownership lock. */
	close(_context: Context): Promise<void> {
		if (this.closing === undefined) {
			this.closed = true;
			this.closing = this.release();
		}
		return this.closing;
	}

	private async release(): Promise<void> {
		if (this.admitted > 0) {
			await new Promise<void>((resolve) => {
				this.drained = resolve;
			});
		}
		try {
			if (this.lockLost === undefined)
				await this.lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [this.lockKey]);
		} finally {
			await this.lockClient.end();
		}
	}

	/** Every operation is admitted, so `close()` returns only after its queries are done and the pool may end. */
	private async admit<T>(operation: () => Promise<T>): Promise<T> {
		this.assertOpen();
		this.admitted++;
		try {
			return await operation();
		} finally {
			if (--this.admitted === 0) this.drained?.();
		}
	}

	private async readConversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		const row = await getRow<JsonRow>(
			this.pool,
			`SELECT record FROM ${this.schema.tables.conversations} WHERE id = ?`,
			id,
		);
		return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
	}

	/** A fork parent; conversations are immutable once committed, so the chain is always complete. */
	private async readAncestor(id: ConversationId): Promise<ConversationRecord> {
		const conversation = await this.readConversation(id);
		if (conversation === undefined) throw new Error(`Durable PostgreSQL conversation ${id} is missing`);
		return conversation;
	}

	private async materializeDocument(
		executor: Executor,
		id: DocumentId,
		at: DocumentPoint,
	): Promise<StoredDocument | undefined> {
		const row = await getRow<JsonRow>(executor, `SELECT record FROM ${this.schema.tables.documents} WHERE id = ?`, id);
		if (row === undefined) return undefined;
		const record = parseJson<DocumentRecord>(row.record);
		if (at !== "current" && isCurrentOnly(record)) {
			throw new StorageRequestError(`Document ${id} does not retain historical content`);
		}
		if (!isAliveAt(record, at)) return undefined;
		const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
		const base = await getRow<RevisionRow>(
			executor,
			`SELECT seq, kind, version, content FROM ${this.schema.tables.documentRevisions}
				WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
			id,
			upper,
		);
		if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
		const baseVersion = toInt(base.version);
		let value = parseJson<JsonObject>(base.content);
		const tail = await allRows<RevisionRow>(
			executor,
			`SELECT seq, kind, version, content FROM ${this.schema.tables.documentRevisions}
				WHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
			id,
			toInt(base.seq),
			upper,
		);
		for (const revision of tail) {
			if (revision.kind !== "delta" || toInt(revision.version) !== baseVersion) {
				throw new Error(`Document ${id} crosses a stored version boundary without a base`);
			}
			value = apply(value, parseJson<readonly Op[]>(revision.content)) as JsonObject;
		}
		return { record, version: baseVersion, value, deltasSinceBase: tail.length };
	}

	private candidateNextId(writes: readonly StorageWrite[]): number {
		let nextId = this.nextId;
		for (const write of writes) {
			const id = writeId(write);
			if (id !== undefined) nextId = Math.max(nextId, id + 1);
		}
		return nextId;
	}

	private async checkGlobalIds(executor: Executor, writes: readonly StorageWrite[]): Promise<void> {
		const claimed = new Map<Id<string>, TableName>();
		for (const write of writes) {
			if (write.type === "document.change" || write.type === "document.retire") continue;
			const document = write.type === "document.create" || write.type === "document.copy";
			const table: TableName = document ? "document" : write.type;
			const id = document ? write.record.id : write.value.id;
			const existing = (
				await getRow<RecordIdRow>(executor, `SELECT record_type FROM ${this.schema.tables.recordIds} WHERE id = ?`, id)
			)?.record_type;
			const earlier = claimed.get(id);
			if (table === "conversation" || table === "entry" || table === "document") {
				if (existing !== undefined) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined) throw new Error(`ID ${id} is written more than once`);
			} else {
				if (existing !== undefined && existing !== table) throw new Error(`ID ${id} already belongs to ${existing}`);
				if (earlier !== undefined && earlier !== table) throw new Error(`ID ${id} is written as two record types`);
			}
			claimed.set(id, table);
		}
	}

	private prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
		const actions = new Map<DocumentId, DocumentAction>();
		for (const write of writes) {
			if (
				write.type !== "document.create" &&
				write.type !== "document.copy" &&
				write.type !== "document.change" &&
				write.type !== "document.retire"
			) {
				continue;
			}
			const id = write.type === "document.create" || write.type === "document.copy" ? write.record.id : write.id;
			let action = actions.get(id);
			if (action === undefined) {
				action = { retire: false };
				actions.set(id, action);
			}
			switch (write.type) {
				case "document.create":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.content = write.content;
					break;
				case "document.copy":
					if (action.create !== undefined || action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.create = write.record;
					action.copy = write.source;
					break;
				case "document.change":
					if (action.content !== undefined || action.copy !== undefined) {
						throw new Error(`Document ${id} has more than one content command`);
					}
					action.content = write.content;
					break;
				case "document.retire":
					if (action.retire) throw new Error(`Document ${id} is retired more than once`);
					action.retire = true;
					break;
			}
		}
		return actions;
	}

	private async checkDocumentActions(
		executor: Executor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
	): Promise<void> {
		const liveCounts = new Map<string, number>();
		for (const [id, action] of actions) {
			if (action.copy !== undefined && actions.has(action.copy.id)) {
				throw new Error(`Document copy ${id} source is changed in the copy batch`);
			}
			const row = await getRow<JsonRow>(
				executor,
				`SELECT record FROM ${this.schema.tables.documents} WHERE id = ?`,
				id,
			);
			const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
			if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
			if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
			if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
			if (action.content?.kind === "delta") {
				const previous = await getRow<VersionRow>(
					executor,
					`SELECT version FROM ${this.schema.tables.documentRevisions} WHERE document_id = ? ORDER BY seq DESC LIMIT 1`,
					id,
				);
				if (previous === undefined) throw new Error(`Document ${id} delta has no base`);
				if (toInt(previous.version) !== action.content.version) {
					throw new Error(`Document ${id} version transition requires a base`);
				}
			}
			const record = action.create ?? existing;
			if (record === undefined) throw new Error(`Unknown document: ${id}`);
			const key = addressKey(record);
			let live = liveCounts.get(key);
			if (live === undefined) live = (await this.currentDocumentId(executor, record)) === undefined ? 0 : 1;
			if (action.retire && existing !== undefined) live--;
			if (action.create !== undefined && !action.retire) live++;
			liveCounts.set(key, live);
		}
		for (const live of liveCounts.values()) {
			if (live > 1) throw new Error("Document address already has a current incarnation");
		}
	}

	private async currentDocumentId(
		executor: Executor,
		address: DocumentAddress | DocumentCreate | DocumentRecord,
	): Promise<DocumentId | undefined> {
		const parts = addressParts(address);
		const id = (
			await getRow<IdRow>(
				executor,
				`SELECT id FROM ${this.schema.tables.documents}
				WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ? AND retired_at IS NULL
				LIMIT 1`,
				parts.kind,
				parts.scopeKind,
				parts.ownerId,
				parts.family,
				parts.keyValue,
			)
		)?.id;
		return id === undefined ? undefined : (toInt(id) as DocumentId);
	}

	private async applyTableWrite(executor: Executor, write: StorageWrite, seq: Seq): Promise<void> {
		switch (write.type) {
			case "conversation":
				await this.claimId(executor, write.value.id, "conversation");
				await run(
					executor,
					`INSERT INTO ${this.schema.tables.conversations} (id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?)`,
					write.value.id,
					write.value.owner?.conversationId ?? null,
					write.value.owner?.taskId ?? null,
					encodeJson(write.value),
				);
				break;
			case "entry":
				await this.claimId(executor, write.value.id, "entry");
				await run(
					executor,
					`INSERT INTO ${this.schema.tables.entries} (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)`,
					write.value.id,
					write.value.conversationId,
					write.value.head ?? null,
					seq,
					encodeJson(write.value),
				);
				break;
			case "task":
				await this.claimId(executor, write.value.id, "task");
				await run(
					executor,
					`INSERT INTO ${this.schema.tables.tasks} (id, conversation_id, kind, status, abort_requested, background, record)
						VALUES (?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, kind = excluded.kind,
						status = excluded.status, abort_requested = excluded.abort_requested,
						background = excluded.background, record = excluded.record`,
					write.value.id,
					write.value.conversationId,
					encodeIndexedString(write.value.kind),
					write.value.state.status,
					write.value.abortRequested ? 1 : 0,
					write.value.background ? 1 : 0,
					encodeJson(write.value),
				);
				break;
			case "submission":
				await this.claimId(executor, write.value.id, "submission");
				await run(
					executor,
					`INSERT INTO ${this.schema.tables.submissions} (id, conversation_id, request_id, status, record) VALUES (?, ?, ?, ?, ?)
						ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id,
						request_id = excluded.request_id, status = excluded.status, record = excluded.record`,
					write.value.id,
					write.value.conversationId,
					write.value.requestId === undefined ? null : encodeIndexedString(write.value.requestId),
					write.value.status,
					encodeJson(write.value),
				);
				break;
			case "document.create":
			case "document.copy":
			case "document.change":
			case "document.retire":
				break;
		}
	}

	private async claimId(executor: Executor, id: Id<string>, table: TableName): Promise<void> {
		await run(
			executor,
			`INSERT INTO ${this.schema.tables.recordIds} (id, record_type) VALUES (?, ?) ON CONFLICT DO NOTHING`,
			id,
			table,
		);
	}

	private async applyDocumentActions(
		executor: Executor,
		actions: ReadonlyMap<DocumentId, DocumentAction>,
		seq: Seq,
	): Promise<void> {
		for (const [id, action] of actions) {
			let content = action.content;
			if (action.copy !== undefined) {
				try {
					const stored = await this.materializeDocument(executor, action.copy.id, action.copy.at);
					if (stored === undefined) throw new Error(`Fork source document ${action.copy.id} cannot be read`);
					const create = action.create;
					if (
						create === undefined ||
						stored.record.scope.kind !== "conversation" ||
						create.scope.kind !== "conversation" ||
						stored.record.kind !== create.kind ||
						stored.record.key !== create.key ||
						stored.record.history !== create.history ||
						stored.record.fork !== create.fork
					) {
						throw new Error(`Fork source document ${action.copy.id} does not match the copied record`);
					}
					content = { kind: "base", version: stored.version, value: stored.value };
				} catch (error) {
					throw new Error(`Document copy ${id} was rejected`, { cause: error });
				}
			}
			let record: DocumentRecord;
			if (action.create !== undefined) {
				record = {
					...action.create,
					createdAt: seq,
					...(action.retire ? { retiredAt: seq } : {}),
				};
				const parts = addressParts(record);
				await this.claimId(executor, id, "document");
				await run(
					executor,
					`INSERT INTO ${this.schema.tables.documents}
						(id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					id,
					parts.kind,
					parts.family,
					parts.keyValue,
					parts.scopeKind,
					parts.ownerId,
					seq,
					action.retire ? seq : null,
					encodeJson(record),
				);
			} else {
				const row = await getRow<JsonRow>(
					executor,
					`SELECT record FROM ${this.schema.tables.documents} WHERE id = ?`,
					id,
				);
				if (row === undefined) throw new Error(`Unknown document: ${id}`);
				record = parseJson<DocumentRecord>(row.record);
			}

			if (content !== undefined) {
				if (content.kind === "base" && isCurrentOnly(record)) {
					await run(executor, `DELETE FROM ${this.schema.tables.documentRevisions} WHERE document_id = ?`, id);
				}
				const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
				await run(
					executor,
					`INSERT INTO ${this.schema.tables.documentRevisions} (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)`,
					id,
					seq,
					content.kind,
					content.version,
					encodedContent,
				);
			}

			if (action.retire) {
				if (action.create === undefined) {
					record = { ...record, retiredAt: seq };
					await run(
						executor,
						`UPDATE ${this.schema.tables.documents} SET retired_at = ?, record = ? WHERE id = ?`,
						seq,
						encodeJson(record),
						id,
					);
				}
				if (isCurrentOnly(record)) {
					await run(executor, `DELETE FROM ${this.schema.tables.documentRevisions} WHERE document_id = ?`, id);
				}
			}
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("PgStorage is closed");
		this.assertOwned();
	}

	private assertOwned(): void {
		if (this.lockLost !== undefined) {
			throw new Error("PgStorage lost its ownership lock connection", { cause: this.lockLost });
		}
	}
}

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
//
// The port is split by concern: schema.ts (layout, migrations, ownership keys), sql.ts (query plumbing, scans),
// reads.ts and commit.ts; PgStorage below owns admission, commit serialization and the ownership lock.

import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	Page,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
} from "@earendil-works/pi-durable";
import pg from "pg";
import { candidateNextId, commitBatch, prepareDocumentActions } from "./commit.ts";
import {
	findDocument,
	materializeDocument,
	readConversation,
	readEntries,
	readEntry,
	readLatestHeadMarker,
	readSubmission,
	readSubmissionByRequest,
	readTask,
	type StoredTask,
	scanConversations,
	scanDocuments,
	scanSubmissions,
	scanTasks,
} from "./reads.ts";
import {
	advisoryKey,
	applyMigrations,
	createMigrations,
	createSchema,
	ensureEntryCompression,
	type PgSchema,
	validatePrefix,
} from "./schema.ts";
import { getRow, inTransaction, type MetadataRow } from "./sql.ts";

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
			await ensureEntryCompression(pool, schema);
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
		const documentActions = prepareDocumentActions(writes);
		const nextId = candidateNextId(this.nextId, writes);
		return inTransaction(
			this.pool,
			"BEGIN",
			(transaction) => commitBatch(transaction, this.schema, writes, documentActions, nextId),
			() => {
				this.nextId = Math.max(this.nextId, nextId);
			},
		);
	}

	async mintId<I extends Id<string>>(): Promise<I> {
		this.assertOpen();
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++ as I;
	}

	conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
		return this.admit(() => readConversation(this.pool, this.schema, id));
	}

	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.admit(() => scanConversations(this.pool, this.schema, query, limit, cursor));
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
		return this.admit(() => readEntry(this.pool, this.schema, idOrConversationId, idOrContext, context));
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		_context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.admit(() => readLatestHeadMarker(this.pool, this.schema, conversationId, atOrBeforeEntryId));
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.admit(() => readEntries(this.pool, this.schema, query, limit, cursor));
	}

	task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
		return this.admit(() => readTask(this.pool, this.schema, id));
	}

	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<StoredTask, Cursor>> {
		return this.admit(() => scanTasks(this.pool, this.schema, query, limit, cursor));
	}

	submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
		return this.admit(() => readSubmission(this.pool, this.schema, id));
	}

	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.admit(() => scanSubmissions(this.pool, this.schema, query, limit, cursor));
	}

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		_context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.admit(() => readSubmissionByRequest(this.pool, this.schema, conversationId, requestId));
	}

	findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
		return this.admit(() => findDocument(this.pool, this.schema, address, at));
	}

	document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
		// The record and revision queries must observe one committed state; a commit between them can replace the base.
		return this.admit(() =>
			inTransaction(this.pool, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", (transaction) =>
				materializeDocument(transaction, this.schema, id, at),
			),
		);
	}

	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		_context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.admit(() => scanDocuments(this.pool, this.schema, query, limit, cursor));
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

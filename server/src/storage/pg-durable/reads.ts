// Reads of the PostgreSQL port of pi-durable's storage; see index.ts for origin and license. Each read takes the pool
// (or, for `document()`, a snapshot transaction) and the table layout; admission stays with PgStorage.

import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import {
	type ConversationId,
	type ConversationQuery,
	type ConversationRecord,
	type Cursor,
	type DocumentAddress,
	type DocumentCreate,
	type DocumentId,
	type DocumentPoint,
	type DocumentQuery,
	type DocumentRecord,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type JsonObject,
	type Page,
	type Seq,
	StorageRequestError,
	type StoredDocument,
	type SubmissionId,
	type SubmissionQuery,
	type SubmissionRecord,
	type TaskId,
	type TaskQuery,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import type { PgSchema } from "./schema.ts";
import {
	allRows,
	cursorId,
	type EntryJsonRow,
	type Executor,
	encodeIndexedString,
	getRow,
	type JsonRow,
	page,
	parseJson,
	type RevisionRow,
	type SqlValue,
	scanSql,
	scanStart,
	toInt,
} from "./sql.ts";

export type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type ScopeColumns = {
	readonly scopeKind: DocumentRecord["scope"]["kind"];
	readonly ownerId: number;
};

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

export const addressParts = (address: DocumentAddress | DocumentCreate | DocumentRecord) => {
	const scope = scopeColumns(address.scope);
	return {
		kind: encodeIndexedString(address.kind),
		...scope,
		family: address.key === undefined ? 0 : 1,
		keyValue: encodeIndexedString(address.key ?? ""),
	};
};

const isAliveAt = (record: DocumentRecord, at: DocumentPoint): boolean => {
	if (at === "current") return record.retiredAt === undefined;
	return record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
};

export const isCurrentOnly = (record: DocumentRecord): boolean =>
	record.scope.kind !== "conversation" || record.history === "latest";

export async function scanConversations(
	pool: Executor,
	schema: PgSchema,
	query: ConversationQuery,
	limit: number,
	cursor: Cursor | undefined,
): Promise<Page<ConversationRecord, Cursor>> {
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
		pool,
		`SELECT record FROM ${schema.tables.conversations} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
		...params,
	);
	return page(
		rows.map((row) => parseJson<ConversationRecord>(row.record)),
		limit,
		start.order,
	);
}

export async function readEntry(
	pool: Executor,
	schema: PgSchema,
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
		conversation = await readConversation(pool, schema, conversationId);
		if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
	}
	const row = await getRow<EntryJsonRow>(
		pool,
		`SELECT record, commit_seq FROM ${schema.tables.entries} WHERE id = ?`,
		id,
	);
	if (row === undefined) return undefined;
	const entry = parseJson<EntryRecord>(row.record);
	if (conversation !== undefined) {
		let upperEntryId = Number.POSITIVE_INFINITY;
		while (conversation.id !== entry.conversationId) {
			if (conversation.parent === undefined) return undefined;
			upperEntryId = Math.min(upperEntryId, conversation.parent.at);
			conversation = await readAncestor(pool, schema, conversation.parent.conversationId);
		}
		if (entry.id > upperEntryId) return undefined;
	}
	return { entry, commitSeq: toInt(row.commit_seq) as Seq };
}

export async function readLatestHeadMarker(
	pool: Executor,
	schema: PgSchema,
	conversationId: ConversationId,
	atOrBeforeEntryId: EntryId | undefined,
): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
	let conversation = await readConversation(pool, schema, conversationId);
	if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
	let upper: number | undefined = atOrBeforeEntryId;
	while (true) {
		const row =
			upper === undefined
				? await getRow<JsonRow>(
						pool,
						`SELECT record FROM ${schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL ORDER BY id DESC LIMIT 1`,
						conversation.id,
					)
				: await getRow<JsonRow>(
						pool,
						`SELECT record FROM ${schema.tables.entries} WHERE conversation_id = ? AND head IS NOT NULL AND id <= ? ORDER BY id DESC LIMIT 1`,
						conversation.id,
						upper,
					);
		if (row !== undefined) return parseJson<EntryRecord & { readonly head: EntryId }>(row.record);
		if (conversation.parent === undefined) return undefined;
		upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
		conversation = await readAncestor(pool, schema, conversation.parent.conversationId);
	}
}

export async function readEntries(
	pool: Executor,
	schema: PgSchema,
	query: EntryQuery,
	limit: number,
	cursor: Cursor | undefined,
): Promise<Page<EntryRecord, Cursor>> {
	const { order, after } = scanStart(query.order, cursor, "descending");
	if (order === "ascending") return readEntriesAscending(pool, schema, query, limit, after);
	let conversation = await readConversation(pool, schema, query.conversationId);
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
			pool,
			`SELECT record FROM ${schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`,
			...params,
		);
		values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
		if (values.length > limit || conversation.parent === undefined) break;
		upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
		if (query.minEntryId !== undefined && upper < query.minEntryId) break;
		conversation = await readAncestor(pool, schema, conversation.parent.conversationId);
	}
	return page(values, limit, "descending");
}

/** Oldest first: the fork chain's segments from the root conversation forward, each up to its fork point. */
async function readEntriesAscending(
	pool: Executor,
	schema: PgSchema,
	query: EntryQuery,
	limit: number,
	after: number | undefined,
): Promise<Page<EntryRecord, Cursor>> {
	const segments: { readonly conversationId: ConversationId; readonly upper: number | undefined }[] = [];
	let conversation = await readConversation(pool, schema, query.conversationId);
	if (conversation === undefined) throw new StorageRequestError(`Unknown conversation: ${query.conversationId}`);
	let upper: number | undefined = query.maxEntryId;
	while (true) {
		segments.push({ conversationId: conversation.id, upper });
		if (conversation.parent === undefined) break;
		upper = upper === undefined ? conversation.parent.at : Math.min(upper, conversation.parent.at);
		if (query.minEntryId !== undefined && upper < query.minEntryId) break;
		conversation = await readAncestor(pool, schema, conversation.parent.conversationId);
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
			pool,
			`SELECT record FROM ${schema.tables.entries} WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`,
			...params,
		);
		values.push(...rows.map((row) => parseJson<EntryRecord>(row.record)));
		if (values.length > limit) break;
	}
	return page(values, limit, "ascending");
}

export async function readTask(pool: Executor, schema: PgSchema, id: TaskId): Promise<StoredTask | undefined> {
	const row = await getRow<JsonRow>(pool, `SELECT record FROM ${schema.tables.tasks} WHERE id = ?`, id);
	return row === undefined ? undefined : parseJson<StoredTask>(row.record);
}

export async function scanTasks(
	pool: Executor,
	schema: PgSchema,
	query: TaskQuery,
	limit: number,
	cursor: Cursor | undefined,
): Promise<Page<StoredTask, Cursor>> {
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
		pool,
		`SELECT record FROM ${schema.tables.tasks} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
		...params,
	);
	return page(
		rows.map((row) => parseJson<StoredTask>(row.record)),
		limit,
		start.order,
	);
}

export async function readSubmission(
	pool: Executor,
	schema: PgSchema,
	id: SubmissionId,
): Promise<SubmissionRecord | undefined> {
	const row = await getRow<JsonRow>(pool, `SELECT record FROM ${schema.tables.submissions} WHERE id = ?`, id);
	return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
}

export async function scanSubmissions(
	pool: Executor,
	schema: PgSchema,
	query: SubmissionQuery,
	limit: number,
	cursor: Cursor | undefined,
): Promise<Page<SubmissionRecord, Cursor>> {
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
		pool,
		`SELECT record FROM ${schema.tables.submissions} WHERE ${clauses.join(" AND ")} ORDER BY id ${scan.direction} LIMIT ?`,
		...params,
	);
	return page(
		rows.map((row) => parseJson<SubmissionRecord>(row.record)),
		limit,
		start.order,
	);
}

export async function readSubmissionByRequest(
	pool: Executor,
	schema: PgSchema,
	conversationId: ConversationId,
	requestId: string,
): Promise<SubmissionRecord | undefined> {
	const row = await getRow<JsonRow>(
		pool,
		`SELECT record FROM ${schema.tables.submissions} WHERE conversation_id = ? AND request_id = ?`,
		conversationId,
		encodeIndexedString(requestId),
	);
	return row === undefined ? undefined : parseJson<SubmissionRecord>(row.record);
}

export async function findDocument(
	pool: Executor,
	schema: PgSchema,
	address: DocumentAddress,
	at: DocumentPoint,
): Promise<DocumentRecord | undefined> {
	const parts = addressParts(address);
	const sql =
		at === "current"
			? `SELECT record FROM ${schema.tables.documents}
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`
			: `SELECT record FROM ${schema.tables.documents}
					WHERE kind = ? AND scope_kind = ? AND owner_id = ? AND family = ? AND key_value = ?
					AND created_at <= ? AND (retired_at IS NULL OR retired_at > ?)
					ORDER BY created_at DESC LIMIT 1`;
	const params: SqlValue[] = [parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue];
	if (at !== "current") params.push(at, at);
	const row = await getRow<JsonRow>(pool, sql, ...params);
	return row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
}

export async function scanDocuments(
	pool: Executor,
	schema: PgSchema,
	query: DocumentQuery,
	limit: number,
	cursor: Cursor | undefined,
): Promise<Page<DocumentRecord, Cursor>> {
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
		pool,
		`SELECT record FROM ${schema.tables.documents} WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
		...params,
	);
	return page(
		rows.map((row) => parseJson<DocumentRecord>(row.record)),
		limit,
	);
}

export async function readConversation(
	pool: Executor,
	schema: PgSchema,
	id: ConversationId,
): Promise<ConversationRecord | undefined> {
	const row = await getRow<JsonRow>(pool, `SELECT record FROM ${schema.tables.conversations} WHERE id = ?`, id);
	return row === undefined ? undefined : parseJson<ConversationRecord>(row.record);
}

/** A fork parent; conversations are immutable once committed, so the chain is always complete. */
async function readAncestor(pool: Executor, schema: PgSchema, id: ConversationId): Promise<ConversationRecord> {
	const conversation = await readConversation(pool, schema, id);
	if (conversation === undefined) throw new Error(`Durable PostgreSQL conversation ${id} is missing`);
	return conversation;
}

export async function materializeDocument(
	executor: Executor,
	schema: PgSchema,
	id: DocumentId,
	at: DocumentPoint,
): Promise<StoredDocument | undefined> {
	const row = await getRow<JsonRow>(executor, `SELECT record FROM ${schema.tables.documents} WHERE id = ?`, id);
	if (row === undefined) return undefined;
	const record = parseJson<DocumentRecord>(row.record);
	if (at !== "current" && isCurrentOnly(record)) {
		throw new StorageRequestError(`Document ${id} does not retain historical content`);
	}
	if (!isAliveAt(record, at)) return undefined;
	const upper = at === "current" ? Number.MAX_SAFE_INTEGER : at;
	const base = await getRow<RevisionRow>(
		executor,
		`SELECT seq, kind, version, content FROM ${schema.tables.documentRevisions}
			WHERE document_id = ? AND kind = 'base' AND seq <= ? ORDER BY seq DESC LIMIT 1`,
		id,
		upper,
	);
	if (base === undefined) throw new Error(`Document ${id} is missing a required base`);
	const baseVersion = toInt(base.version);
	let value = parseJson<JsonObject>(base.content);
	const tail = await allRows<RevisionRow>(
		executor,
		`SELECT seq, kind, version, content FROM ${schema.tables.documentRevisions}
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

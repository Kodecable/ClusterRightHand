// The commit path of the PostgreSQL port of pi-durable's storage; see index.ts for origin and license. PgStorage
// serializes commits and owns the transaction; everything here runs inside it.

import type {
	DocumentAddress,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	Id,
	Seq,
	StorageWrite,
} from "@earendil-works/pi-durable";
import { addressParts, isCurrentOnly, materializeDocument } from "./reads.ts";
import type { PgSchema } from "./schema.ts";
import {
	type Executor,
	encodeIndexedString,
	encodeJson,
	getRow,
	type IdRow,
	type JsonRow,
	type MetadataRow,
	parseJson,
	type RecordIdRow,
	run,
	type TableName,
	toInt,
	type VersionRow,
} from "./sql.ts";

export type DocumentAction = {
	create?: DocumentCreate;
	copy?: Extract<StorageWrite, { readonly type: "document.copy" }>["source"];
	content?: DocumentContent;
	retire: boolean;
};

const addressKey = (address: DocumentAddress | DocumentCreate | DocumentRecord): string => {
	const parts = addressParts(address);
	return JSON.stringify([parts.kind, parts.scopeKind, parts.ownerId, parts.family, parts.keyValue]);
};

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

/** The in-memory ID counter after `writes` commit, starting from `nextId`. */
export function candidateNextId(nextId: number, writes: readonly StorageWrite[]): number {
	let candidate = nextId;
	for (const write of writes) {
		const id = writeId(write);
		if (id !== undefined) candidate = Math.max(candidate, id + 1);
	}
	return candidate;
}

/** Apply one batch inside the commit transaction and return its sequence number. */
export async function commitBatch(
	transaction: Executor,
	schema: PgSchema,
	writes: readonly StorageWrite[],
	documentActions: ReadonlyMap<DocumentId, DocumentAction>,
	candidateNextId: number,
): Promise<Seq> {
	const metadata = await getRow<MetadataRow>(
		transaction,
		`SELECT next_id, next_seq FROM ${schema.tables.durableMetadata} WHERE singleton = 1 FOR UPDATE`,
	);
	if (metadata === undefined) throw new Error("Durable PostgreSQL metadata is missing");
	const committedSeq = toInt(metadata.next_seq) as Seq;
	await checkGlobalIds(transaction, schema, writes);
	await checkDocumentActions(transaction, schema, documentActions);
	for (const write of writes) await applyTableWrite(transaction, schema, write, committedSeq);
	await applyDocumentActions(transaction, schema, documentActions, committedSeq);
	await run(
		transaction,
		`UPDATE ${schema.tables.durableMetadata} SET next_id = ?, next_seq = ? WHERE singleton = 1`,
		Math.max(Number(metadata.next_id), candidateNextId),
		committedSeq + 1,
	);
	return committedSeq;
}

async function checkGlobalIds(executor: Executor, schema: PgSchema, writes: readonly StorageWrite[]): Promise<void> {
	const claimed = new Map<Id<string>, TableName>();
	for (const write of writes) {
		if (write.type === "document.change" || write.type === "document.retire") continue;
		const document = write.type === "document.create" || write.type === "document.copy";
		const table: TableName = document ? "document" : write.type;
		const id = document ? write.record.id : write.value.id;
		const existing = (
			await getRow<RecordIdRow>(executor, `SELECT record_type FROM ${schema.tables.recordIds} WHERE id = ?`, id)
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

export function prepareDocumentActions(writes: readonly StorageWrite[]): Map<DocumentId, DocumentAction> {
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

async function checkDocumentActions(
	executor: Executor,
	schema: PgSchema,
	actions: ReadonlyMap<DocumentId, DocumentAction>,
): Promise<void> {
	const liveCounts = new Map<string, number>();
	for (const [id, action] of actions) {
		if (action.copy !== undefined && actions.has(action.copy.id)) {
			throw new Error(`Document copy ${id} source is changed in the copy batch`);
		}
		const row = await getRow<JsonRow>(executor, `SELECT record FROM ${schema.tables.documents} WHERE id = ?`, id);
		const existing = row === undefined ? undefined : parseJson<DocumentRecord>(row.record);
		if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
		if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
		if (existing?.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
		if (action.content?.kind === "delta") {
			const previous = await getRow<VersionRow>(
				executor,
				`SELECT version FROM ${schema.tables.documentRevisions} WHERE document_id = ? ORDER BY seq DESC LIMIT 1`,
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
		if (live === undefined) live = (await currentDocumentId(executor, schema, record)) === undefined ? 0 : 1;
		if (action.retire && existing !== undefined) live--;
		if (action.create !== undefined && !action.retire) live++;
		liveCounts.set(key, live);
	}
	for (const live of liveCounts.values()) {
		if (live > 1) throw new Error("Document address already has a current incarnation");
	}
}

async function currentDocumentId(
	executor: Executor,
	schema: PgSchema,
	address: DocumentAddress | DocumentCreate | DocumentRecord,
): Promise<DocumentId | undefined> {
	const parts = addressParts(address);
	const id = (
		await getRow<IdRow>(
			executor,
			`SELECT id FROM ${schema.tables.documents}
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

async function applyTableWrite(executor: Executor, schema: PgSchema, write: StorageWrite, seq: Seq): Promise<void> {
	switch (write.type) {
		case "conversation":
			await claimId(executor, schema, write.value.id, "conversation");
			await run(
				executor,
				`INSERT INTO ${schema.tables.conversations} (id, owner_conversation_id, owner_task_id, record) VALUES (?, ?, ?, ?)`,
				write.value.id,
				write.value.owner?.conversationId ?? null,
				write.value.owner?.taskId ?? null,
				encodeJson(write.value),
			);
			break;
		case "entry":
			await claimId(executor, schema, write.value.id, "entry");
			// Explicit columns: `search_text` is a generated column (schema version 2) and must not be listed.
			await run(
				executor,
				`INSERT INTO ${schema.tables.entries} (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)`,
				write.value.id,
				write.value.conversationId,
				write.value.head ?? null,
				seq,
				encodeJson(write.value),
			);
			break;
		case "task":
			await claimId(executor, schema, write.value.id, "task");
			await run(
				executor,
				`INSERT INTO ${schema.tables.tasks} (id, conversation_id, kind, status, abort_requested, background, record)
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
			await claimId(executor, schema, write.value.id, "submission");
			await run(
				executor,
				`INSERT INTO ${schema.tables.submissions} (id, conversation_id, request_id, status, record) VALUES (?, ?, ?, ?, ?)
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

async function claimId(executor: Executor, schema: PgSchema, id: Id<string>, table: TableName): Promise<void> {
	await run(
		executor,
		`INSERT INTO ${schema.tables.recordIds} (id, record_type) VALUES (?, ?) ON CONFLICT DO NOTHING`,
		id,
		table,
	);
}

async function applyDocumentActions(
	executor: Executor,
	schema: PgSchema,
	actions: ReadonlyMap<DocumentId, DocumentAction>,
	seq: Seq,
): Promise<void> {
	for (const [id, action] of actions) {
		let content = action.content;
		if (action.copy !== undefined) {
			try {
				const stored = await materializeDocument(executor, schema, action.copy.id, action.copy.at);
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
			await claimId(executor, schema, id, "document");
			await run(
				executor,
				`INSERT INTO ${schema.tables.documents}
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
			const row = await getRow<JsonRow>(executor, `SELECT record FROM ${schema.tables.documents} WHERE id = ?`, id);
			if (row === undefined) throw new Error(`Unknown document: ${id}`);
			record = parseJson<DocumentRecord>(row.record);
		}

		if (content !== undefined) {
			if (content.kind === "base" && isCurrentOnly(record)) {
				await run(executor, `DELETE FROM ${schema.tables.documentRevisions} WHERE document_id = ?`, id);
			}
			const encodedContent = content.kind === "base" ? encodeJson(content.value) : encodeJson(content.ops);
			await run(
				executor,
				`INSERT INTO ${schema.tables.documentRevisions} (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)`,
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
					`UPDATE ${schema.tables.documents} SET retired_at = ?, record = ? WHERE id = ?`,
					seq,
					encodeJson(record),
					id,
				);
			}
			if (isCurrentOnly(record)) {
				await run(executor, `DELETE FROM ${schema.tables.documentRevisions} WHERE document_id = ?`, id);
			}
		}
	}
}

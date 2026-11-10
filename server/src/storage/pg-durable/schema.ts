// Table layout, migrations and ownership keys of the PostgreSQL port of pi-durable's storage; see index.ts for origin
// and license.

import { createHash } from "node:crypto";
import pg from "pg";
import { getRow, inTransaction, run, toInt, type VersionRow } from "./sql.ts";

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

/** SQL functions the adapter creates; namespaced with the same prefix as the tables. */
const FUNCTION_NAMES = {
	entrySearchText: "entry_search_text",
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

export type PgSchema = {
	/** Schema-qualified, quoted table names. */
	readonly tables: Identifiers<typeof TABLE_NAMES>;
	/** Quoted index names (an index always lives in its table's schema). */
	readonly indexes: Identifiers<typeof INDEX_NAMES>;
	/** Schema-qualified, quoted function names. */
	readonly functions: Identifiers<typeof FUNCTION_NAMES>;
};

const MAX_IDENTIFIER_BYTES = 63;
const LONGEST_NAME = Math.max(
	...[...Object.values(TABLE_NAMES), ...Object.values(INDEX_NAMES), ...Object.values(FUNCTION_NAMES)].map(
		(n) => n.length,
	),
);

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export function validatePrefix(prefix: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
		throw new Error(`Invalid PgStorage prefix ${JSON.stringify(prefix)}: use letters, digits and underscores`);
	}
	if (prefix.length + LONGEST_NAME > MAX_IDENTIFIER_BYTES) {
		throw new Error(`PgStorage prefix ${JSON.stringify(prefix)} is too long`);
	}
}

export function createSchema(schema: string, prefix: string): PgSchema {
	const qualify = (name: string) => `${quoteIdentifier(schema)}.${quoteIdentifier(prefix + name)}`;
	return {
		tables: Object.fromEntries(Object.entries(TABLE_NAMES).map(([key, name]) => [key, qualify(name)])) as Identifiers<
			typeof TABLE_NAMES
		>,
		indexes: Object.fromEntries(
			Object.entries(INDEX_NAMES).map(([key, name]) => [key, quoteIdentifier(prefix + name)]),
		) as Identifiers<typeof INDEX_NAMES>,
		functions: Object.fromEntries(
			Object.entries(FUNCTION_NAMES).map(([key, name]) => [key, qualify(name)]),
		) as Identifiers<typeof FUNCTION_NAMES>,
	};
}

type Migration = { readonly version: number; readonly statements: readonly string[] };

/**
 * Ordered schema history. Version 1 is the SQLite schema at pi-durable 1.4.0 (SQLite version 2) in PostgreSQL;
 * version 2 adds the generated `search_text` column (and the function that computes it) for session search.
 */
export function createMigrations(schema: PgSchema): readonly Migration[] {
	const { tables, indexes, functions } = schema;
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
	/**
	 * The searchable text of one entry record (doc/design/data-model.md "Conversation content search"), or NULL when it carries none: the
	 * user messages' text (`content` as a string, or the `text` items of an array) and the assistant messages'
	 * `text` blocks. Thinking, tool calls, tool results, system prompts and compactions never contribute.
	 * `jsonb_typeof` guards every step, so an unexpected shape yields NULL instead of an error; the result is
	 * capped at 32768 characters. IMMUTABLE, as a generated column requires.
	 */
	const entrySearchText: readonly string[] = [
		`CREATE FUNCTION ${functions.entrySearchText}(entry_record text)
			RETURNS text
			LANGUAGE sql
			IMMUTABLE
			PARALLEL SAFE
			AS $search$
				WITH root AS (
					SELECT entry_record::jsonb AS document
				),
				messages AS (
					SELECT message.value AS message, message.ordinality AS message_ord
					FROM root
					CROSS JOIN LATERAL jsonb_array_elements(
						CASE
							WHEN root.document ->> 'kind' IN ('pi.user', 'pi.assistant')
								AND jsonb_typeof(root.document -> 'model') = 'array'
								THEN root.document -> 'model'
							ELSE '[]'::jsonb
						END
					) WITH ORDINALITY AS message(value, ordinality)
				),
				parts AS (
					SELECT
						root.document ->> 'kind' AS kind,
						messages.message ->> 'role' AS message_role,
						messages.message -> 'content' AS content_value,
						messages.message_ord AS message_ord,
						content.value AS content_item,
						content.ordinality AS content_ord
					FROM messages
					CROSS JOIN root
					LEFT JOIN LATERAL jsonb_array_elements(
						CASE
							WHEN jsonb_typeof(messages.message -> 'content') = 'array' THEN messages.message -> 'content'
							ELSE '[]'::jsonb
						END
					) WITH ORDINALITY AS content(value, ordinality) ON true
				),
				texts AS (
					SELECT
						message_ord,
						coalesce(content_ord, 0) AS content_ord,
						CASE
							WHEN kind = 'pi.user' AND message_role = 'user' AND jsonb_typeof(content_value) = 'string'
								THEN content_value #>> '{}'
							WHEN ((kind = 'pi.user' AND message_role = 'user') OR (kind = 'pi.assistant' AND message_role = 'assistant'))
								AND jsonb_typeof(content_item) = 'object'
								AND content_item ->> 'type' = 'text'
								AND jsonb_typeof(content_item -> 'text') = 'string'
								THEN content_item ->> 'text'
						END AS part_text
					FROM parts
				)
				SELECT left(string_agg(part_text, chr(10) ORDER BY message_ord, content_ord), 32768)
				FROM texts
				WHERE part_text IS NOT NULL AND part_text <> ''
			$search$`,
		`ALTER TABLE ${tables.entries} ADD COLUMN search_text TEXT
			GENERATED ALWAYS AS (${functions.entrySearchText}(record)) STORED`,
	];
	return [
		{ version: 1, statements: initialSchema },
		{ version: 2, statements: entrySearchText },
	];
}

/** A signed 64-bit advisory lock key for one purpose on one (schema, prefix) pair. */
export function advisoryKey(purpose: string, schema: string, prefix: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify(["pi-durable", purpose, schema, prefix]))
		.digest();
	return digest.readBigInt64BE(0).toString();
}

export async function applyMigrations(
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

/**
 * Give `pi_entries.record` lz4 column compression. Checked on every open, not in a versioned migration: a
 * migration skipped before a PostgreSQL upgrade would never run again. Only values written afterwards are
 * compressed, and only rows past the ~2 KB TOAST threshold are actually TOASTed; existing rows keep their
 * compression. A server without the feature is a warning, not an error.
 */
export async function ensureEntryCompression(pool: pg.Pool, schema: PgSchema): Promise<void> {
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

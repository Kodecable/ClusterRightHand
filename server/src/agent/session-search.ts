import type { SessionSearchHit, SessionSearchItem, SessionSearchPage } from "@crh/api";
import { type RawBuilder, type SqlBool, sql } from "kysely";
import type { SessionUser } from "../auth/sessions.ts";
import type { Db } from "../storage/db.ts";
import { isPostgres } from "../storage/dialect.ts";
import { DEFAULT_PG_STORAGE_PREFIX } from "../storage/pg-durable/index.ts";
import { type CursorKey, cursorRows } from "../util/cursor.ts";
import { UserError } from "../util/errors.ts";
import { likeContains } from "../util/list-query.ts";
import { type SessionListScope, sessionListCursor, sessionListItem, sessionListQuery } from "./session-list.ts";

/**
 * Session search (doc/webui.md#会话内容搜索): root sessions whose title or message text matches every keyword
 * of `q`, with the matching transcript entries as hits. PostgreSQL searches the generated `search_text` column
 * the pg-durable adapter adds to `pi_entries`; SQLite has no such column and matches titles only.
 */

export const SESSION_SEARCH_LIMIT_DEFAULT = 20;
export const SESSION_SEARCH_LIMIT_MAX = 50;
/** The query is split into at most this many whitespace-separated keywords. */
export const SESSION_SEARCH_KEYWORDS_MAX = 8;
/** About how many characters a hit's snippet shows. */
const SNIPPET_LENGTH = 120;
/**
 * The entries table of the pg-durable adapter (`search_text` is generated from `record`, see pg-durable/schema.ts).
 * `openAgentStorage` always opens it with the default `pi_` prefix, in the same schema and search_path as this
 * pool, so the unqualified name resolves to the adapter's table.
 */
const ENTRIES_TABLE = `${DEFAULT_PG_STORAGE_PREFIX}entries`;

/** `?limit=` of the search: 1..50, default 20 (the session lists allow more). */
export function parseSearchLimit(raw: string | undefined): number {
	if (raw === undefined) return SESSION_SEARCH_LIMIT_DEFAULT;
	if (!/^\d+$/.test(raw)) throw new UserError(`limit must be an integer from 1 to ${SESSION_SEARCH_LIMIT_MAX}`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > SESSION_SEARCH_LIMIT_MAX) {
		throw new UserError(`limit must be an integer from 1 to ${SESSION_SEARCH_LIMIT_MAX}`);
	}
	return value;
}

/** The keywords of `q`: whitespace-separated, at most 8; an empty or whitespace-only query is a 400. */
export function parseSearchKeywords(raw: string | undefined): string[] {
	const keywords = (raw ?? "")
		.split(/\s+/)
		.filter((keyword) => keyword !== "")
		.slice(0, SESSION_SEARCH_KEYWORDS_MAX);
	if (keywords.length === 0) throw new UserError("q is required");
	return keywords;
}

/** `lower(title) like lower(pattern) escape '\'`, the session list's title rule. */
function titleMatches(pattern: string): RawBuilder<SqlBool> {
	return sql<SqlBool>`lower(coalesce(sessions.title, '')) like lower(${pattern}) escape '\\'`;
}

/**
 * Whether some entry of the outer row's tree (`sessions`) carries the keyword in its generated search text:
 * the root's own conversation or a subagent's (`sessions.root_session_id`, or the root itself when that column
 * was never backfilled). One `exists`, no per-row query, like the list's TREE_STATE. The cast is on the sessions
 * side so the entries' (conversation_id, id) index narrows the scan to the tree's conversations; the CASE keeps a
 * non-numeric id (none in practice) from failing the cast.
 */
function treeEntryMatches(pattern: string): RawBuilder<SqlBool> {
	return sql<SqlBool>`exists (
		select 1
		from ${sql.ref(ENTRIES_TABLE)} as search_entry
		inner join sessions as search_session on search_entry.conversation_id = (case when search_session.conversation_id ~ '^[0-9]+$' then search_session.conversation_id::bigint end)
		where (search_session.id = sessions.id or search_session.root_session_id = sessions.id)
			and search_entry.search_text is not null
			and lower(search_entry.search_text) like lower(${pattern}) escape '\\'
	)`;
}

interface SearchDetail {
	hitCount: number;
	hits: SessionSearchHit[];
}

interface HitRow {
	entry_id: string;
	session_id: string;
	session_title: string | null;
	root_id: string;
	search_text: string;
	match_count: string | number;
	hit_count: string | number;
	entry_role: string;
	at_epoch: number | string | null;
}

/** The hit count and up to three hits per root, in one query over the page's trees. */
async function searchDetails(
	db: Db,
	rootIds: readonly string[],
	patterns: readonly string[],
	keywords: readonly string[],
): Promise<Map<string, SearchDetail>> {
	const roots = sql.join(
		rootIds.map((id) => sql`${id}`),
		sql`, `,
	);
	const anyMatch = sql.join(
		patterns.map((pattern) => sql`lower(tree_entries.search_text) like lower(${pattern}) escape '\\'`),
		sql` or `,
	);
	const matchCount = sql.join(
		patterns.map(
			(pattern) =>
				sql`(case when lower(tree_entries.search_text) like lower(${pattern}) escape '\\' then 1 else 0 end)`,
		),
		sql` + `,
	);
	// The tree's entries first, then only the rows that match at least one keyword: role and timestamp parse
	// the record for those rows only, and the window functions count each matching entry once.
	const { rows } = await sql<HitRow>`
		with tree_entries as (
			select
				search_entry.id as entry_id,
				search_session.id as session_id,
				search_session.title as session_title,
				coalesce(search_session.root_session_id, search_session.id) as root_id,
				search_entry.search_text as search_text,
				search_entry.record as record
			from ${sql.ref(ENTRIES_TABLE)} as search_entry
			inner join sessions as search_session on search_entry.conversation_id = (case when search_session.conversation_id ~ '^[0-9]+$' then search_session.conversation_id::bigint end)
			where (search_session.id in (${roots}) or search_session.root_session_id in (${roots}))
				and search_entry.search_text is not null
		),
		matched as (
			select
				tree_entries.*,
				${matchCount} as match_count
			from tree_entries
			where ${anyMatch}
		),
		ranked as (
			select
				matched.*,
				count(*) over (partition by matched.root_id) as hit_count,
				row_number() over (
					partition by matched.root_id
					order by matched.match_count desc, matched.entry_id desc
				) as hit_rank
			from matched
		)
		select
			entry_id,
			session_id,
			session_title,
			root_id,
			search_text,
			match_count,
			hit_count,
			case when ranked.record::jsonb ->> 'kind' = 'pi.user' then 'user' else 'assistant' end as entry_role,
			case
				when jsonb_typeof(ranked.record::jsonb -> 'model') = 'array' then
					case
						when jsonb_typeof(ranked.record::jsonb -> 'model' -> 0 -> 'timestamp') = 'number'
							then (ranked.record::jsonb -> 'model' -> 0 ->> 'timestamp')::double precision
					end
			end as at_epoch
		from ranked
		where hit_rank <= 3
		order by root_id, hit_rank
	`.execute(db);

	const details = new Map<string, SearchDetail>();
	for (const row of rows) {
		const detail = details.get(row.root_id) ?? { hitCount: Number(row.hit_count), hits: [] };
		detail.hits.push({
			entryId: Number(row.entry_id),
			sessionId: row.session_id,
			sessionTitle: row.session_title,
			role: row.entry_role === "user" ? "user" : "assistant",
			at: isoTime(row.at_epoch),
			snippet: snippet(row.search_text, keywords),
		});
		details.set(row.root_id, detail);
	}
	return details;
}

/** An epoch-milliseconds value from the entry's first model message as ISO 8601, or null. */
function isoTime(value: number | string | null): string | null {
	if (value === null) return null;
	const epoch = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(epoch)) return null;
	const date = new Date(epoch);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * About 120 characters around the first keyword that occurs in `text`, with whitespace collapsed and "…" on a
 * cut side. The first keyword in the query's order wins, matching the entry even when a later one is earlier.
 */
export function snippet(text: string, keywords: readonly string[]): string {
	const lower = text.toLowerCase();
	let start = -1;
	let length = 0;
	for (const keyword of keywords) {
		const found = lower.indexOf(keyword.toLowerCase());
		if (found >= 0) {
			start = found;
			length = keyword.length;
			break;
		}
	}
	// A matched entry always contains a keyword; keep a run with no keyword readable instead of empty.
	if (start < 0) {
		start = 0;
		length = 0;
	}
	let from = Math.max(0, start - Math.max(0, Math.floor((SNIPPET_LENGTH - length) / 2)));
	let to = Math.min(text.length, from + SNIPPET_LENGTH);
	from = Math.max(0, to - SNIPPET_LENGTH);
	// Do not cut a surrogate pair in half.
	if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from++;
	if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to--;
	const body = text.slice(from, to).replace(/\s+/gu, " ").trim();
	return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

export interface SessionSearchOptions {
	scope: SessionListScope;
	keywords: readonly string[];
	cursor?: CursorKey;
	limit: number;
}

/**
 * One cursor page of root sessions matching every keyword in title or tree content, `updated_at desc, id desc`.
 * The scope and visibility are the session list's (`sessionListQuery`), so `shared` and `unread` in each item
 * mean what they mean there. On SQLite only titles are searched and the hit fields stay empty.
 */
export async function sessionSearch(
	db: Db,
	user: SessionUser,
	options: SessionSearchOptions,
): Promise<SessionSearchPage> {
	const contentSearch = isPostgres(db);
	const patterns = options.keywords.map(likeContains);
	const titleMatch = sql<SqlBool>`(${sql.join(
		patterns.map((pattern) => titleMatches(pattern)),
		sql` and `,
	)})`;
	let query = (
		await sessionListQuery(db, user, {
			scope: options.scope,
			...(options.cursor === undefined ? {} : { cursor: options.cursor }),
		})
	).select(titleMatch.as("title_match"));
	for (const pattern of patterns) {
		const title = titleMatches(pattern);
		query = query.where(
			contentSearch ? sql<SqlBool>`(${title} or ${treeEntryMatches(pattern)})` : sql<SqlBool>`${title}`,
		);
	}
	const page = await cursorRows(
		options.limit,
		async (limitPlusOne) => query.limit(limitPlusOne).execute(),
		(row) => sessionListCursor(row.updated_at, row.id),
	);
	const details =
		contentSearch && page.rows.length > 0
			? await searchDetails(
					db,
					page.rows.map((row) => row.id),
					patterns,
					options.keywords,
				)
			: new Map<string, SearchDetail>();
	return {
		items: page.rows.map((row): SessionSearchItem => {
			const detail = details.get(row.id);
			return {
				...sessionListItem(row, user.userId, Boolean(row.shared)),
				titleMatch: Boolean(row.title_match),
				hitCount: detail?.hitCount ?? 0,
				hits: detail?.hits ?? [],
			};
		}),
		nextCursor: page.nextCursor,
		contentSearch,
	};
}

import { type RawBuilder, sql } from "kysely";
import { UserError } from "./errors.ts";

/**
 * The search parameters of the entity list endpoints (doc/design/webui.md "Entity search"):
 * `q`, `limit` and `ids`. Validation lives here instead of in the routes, so every
 * service answers the same 400 and the routes only pass the raw query through.
 *
 * The SQL helpers stay portable: both SQLite and PostgreSQL understand
 * `lower(col) like lower(?) escape '\'`, and escaping `%`, `_` and `\` is the
 * caller's text's business, not the wildcards we add around it.
 */

export const LIST_LIMIT_MAX = 100;
export const LIST_IDS_MAX = 100;

/** The raw query strings as Hono reads them; `packages/api`'s `EntityListQuery` is the client-side shape. */
export interface RawEntityListQuery {
	q?: string;
	limit?: string;
	ids?: string;
}

export interface ParsedListQuery {
	/** Trimmed; undefined when absent or only whitespace. */
	q: string | undefined;
	limit: number | undefined;
	ids: string[] | undefined;
}

function parseLimit(raw: string): number {
	const text = raw.trim();
	if (!/^\d+$/.test(text)) throw new UserError(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
	const limit = Number(text);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
		throw new UserError(`limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);
	}
	return limit;
}

function parseIds(raw: string): string[] {
	const parts = raw.split(",").map((part) => part.trim());
	if (parts.length === 0 || parts.some((part) => part === "")) {
		throw new UserError("ids must be a comma-separated list of ids");
	}
	const ids = [...new Set(parts)];
	if (ids.length > LIST_IDS_MAX) throw new UserError(`ids must name at most ${LIST_IDS_MAX} items`);
	return ids;
}

/** Validates and normalizes the `q`, `limit` and `ids` query parameters. */
export function parseListQuery(query: RawEntityListQuery): ParsedListQuery {
	const q = query.q?.trim() ?? "";
	const ids = query.ids === undefined ? undefined : parseIds(query.ids);
	const limit = query.limit === undefined ? undefined : parseLimit(query.limit);
	if (ids !== undefined && (q !== "" || limit !== undefined)) {
		throw new UserError("ids cannot be combined with q or limit");
	}
	return { q: q === "" ? undefined : q, limit, ids };
}

/** Escapes the LIKE metacharacters in a user's text so they match literally. */
export function escapeLike(text: string): string {
	return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** A `%text%` pattern for a case-insensitive substring match. */
export function likeContains(text: string): string {
	return `%${escapeLike(text)}%`;
}

/** A `text%` pattern for a case-insensitive prefix match. */
export function likePrefix(text: string): string {
	return `${escapeLike(text)}%`;
}

/**
 * `lower(col) like lower(pattern) escape '\'` for any of the named columns, OR-ed
 * together. The pattern must already carry its `%` wildcards.
 */
export function textMatches(columns: readonly string[], pattern: string): RawBuilder<boolean> {
	return sql<boolean>`(${sql.join(
		columns.map((column) => sql`lower(${sql.ref(column)}) like lower(${pattern}) escape '\\'`),
		sql` or `,
	)})`;
}

/** 0 for a prefix match on any column, 1 for a substring match: the search order's first key. */
export function prefixRank(columns: readonly string[], q: string): RawBuilder<number> {
	return sql<number>`case when ${textMatches(columns, likePrefix(q))} then 0 else 1 end`;
}

/** `lower(col)` as a case-insensitive second ordering key. */
export function lowerCase(column: string): RawBuilder<string> {
	return sql<string>`lower(${sql.ref(column)})`;
}

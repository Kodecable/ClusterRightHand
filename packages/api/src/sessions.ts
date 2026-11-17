/**
 * Sessions, shares and quota waits (doc/design/webui.md "Session list API",
 * doc/design/access-control.md "Ownership, access grants and sharing", doc/design/agent-runtime.md "Quota and token accounting").
 *
 * The wire types are derived from their schemas, so the handlers, the WebUI and the API document cannot drift.
 */

import type { z } from "zod";
import type { CursorQuery } from "./common.ts";
import type {
	ChatAttachmentInputSchema,
	QuotaApprovalSchema,
	SessionCapabilitiesSchema,
	SessionChildrenSummarySchema,
	SessionEntrySchema,
	SessionForkBodySchema,
	SessionForkedFromSchema,
	SessionListItemSchema,
	SessionListScopeSchema,
	SessionPatchBodySchema,
	SessionRelationshipSchema,
	SessionRunStateSchema,
	SessionSearchHitSchema,
	SessionSearchItemSchema,
	SessionSearchResponseSchema,
	SessionShareAccessSchema,
	SessionShareSchema,
	SessionStatsSchema,
	SessionViewSchema,
	SessionWaitingKindSchema,
} from "./schemas/sessions.ts";

/**
 * The longest session title, counted in Unicode code points
 * (doc/design/agent-runtime.md "Title generation"). Generated titles are cut to it, and a user-set title
 * longer than it is rejected by the route schema instead of being silently truncated.
 */
export const SESSION_TITLE_MAX_CHARS = 60;

export type SessionRelationship = z.infer<typeof SessionRelationshipSchema>;
export type SessionShareAccess = z.infer<typeof SessionShareAccessSchema>;

export type SessionCapabilities = z.infer<typeof SessionCapabilitiesSchema>;

export type SessionShare = z.infer<typeof SessionShareSchema>;

/** The three states of a session tree (doc/design/agent-runtime.md "Session state"). */
export type SessionRunState = z.infer<typeof SessionRunStateSchema>;

/** Why an `awaiting` session is blocked; the tree reports its highest-priority wait. */
export type SessionWaitingKind = z.infer<typeof SessionWaitingKindSchema>;

/** The lightweight row of `GET /api/sessions` (doc/design/webui.md "API conventions"). */
export type SessionListItem = z.infer<typeof SessionListItemSchema>;

/** The counts of a session's direct child sessions by their own state (`GET /sessions/:id/children/summary`). */
export type SessionChildrenSummary = z.infer<typeof SessionChildrenSummarySchema>;

/** `visible` is the web's only scope: the caller's own roots plus the roots shared with them. */
export type SessionListScope = z.infer<typeof SessionListScopeSchema>;

/** One transcript entry that matched a content search (`GET /api/sessions/search`). */
export type SessionSearchHit = z.infer<typeof SessionSearchHitSchema>;

/**
 * A root session matched by `GET /api/sessions/search`: the list item plus the title/content match details.
 * On SQLite only titles are searched, so `hits` is empty, `hitCount` is 0 and a match always has `titleMatch`.
 */
export type SessionSearchItem = z.infer<typeof SessionSearchItemSchema>;

/** `GET /api/sessions/search`: one cursor page of matching root sessions. */
export type SessionSearchPage = z.infer<typeof SessionSearchResponseSchema>;

/** Query parameters of `GET /api/sessions/search`; `q` is required. */
export interface SessionSearchQuery extends CursorQuery {
	/** Whitespace-separated keywords, at most 8; every keyword must match. */
	q: string;
	/** Same scopes as the session list; default `mine`. */
	scope?: SessionListScope;
}

export interface SessionListQuery extends CursorQuery {
	scope?: SessionListScope;
	q?: string;
	/**
	 * Only roots owned by this user. Served by the admin-only `all` scope; for
	 * every other scope it can only narrow what the caller may already see.
	 */
	ownerId?: string;
}

/** A session's own generation counters, plus the tree's input and cache-read totals (doc/design/agent-runtime.md "Session statistics"). */
export type SessionStats = z.infer<typeof SessionStatsSchema>;

/**
 * `GET /api/sessions/:id`: the session, how the caller relates to it and
 * their effective capabilities. `shares` is present only for the owner and
 * administrators (those allowed to manage shares).
 */
export type SessionView = z.infer<typeof SessionViewSchema>;

/** Where a forked session came from (doc/design/agent-runtime.md "Forking"). */
export type SessionForkedFrom = z.infer<typeof SessionForkedFromSchema>;

/** Body of `POST /api/sessions/:id/fork`: the final reply to fork at and the idempotency key. */
export type SessionForkInput = z.infer<typeof SessionForkBodySchema>;

/** Body of `PATCH /api/sessions/:id`; omitted fields stay unchanged, null clears. */
export type SessionPatch = z.infer<typeof SessionPatchBodySchema>;

/** One transcript entry in a history page; the response view, not the full stored record. */
export type SessionEntry = z.infer<typeof SessionEntrySchema>;

/** A root whose token quota is used up and waits for the owner's decision (doc/design/agent-runtime.md "Quota and token accounting"). */
export type QuotaApproval = z.infer<typeof QuotaApprovalSchema>;

/** One attachment the composer uploads to the owner's library or picks from it (doc/design/library.md "Chat attachments"). */
export type ChatAttachmentInput = z.infer<typeof ChatAttachmentInputSchema>;

/**
 * One attachment of a submitted chat message, as the entry's `data` carries it and the transcript renders
 * it (doc/design/library.md "Chat attachments"). The server takes name, size, media type and SHA-256 from
 * the library row, never from the request.
 */
export interface ChatAttachment {
	library: string;
	/**
	 * The library's id, so the WebUI resolves a renamed library by id instead of the (possibly stale)
	 * reference; entries written before this field have none and use `library`.
	 */
	libraryId?: string;
	path: string;
	name: string;
	bytes: number;
	mime: string;
	sha256: string;
	/** Whether the file's text content was included in the model content. */
	inlined: boolean;
}

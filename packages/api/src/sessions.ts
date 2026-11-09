/**
 * Sessions, shares and quota waits (doc/webui.md "会话列表",
 * doc/access-control.md "归属与分享", doc/agent-runtime.md "配额").
 */

import type { CursorQuery, RefMap } from "./common.ts";
import type { ModelRef } from "./models.ts";
import type { GranteeType } from "./nodes.ts";
import type { RulePreset, StoredRuleSet } from "./policy.ts";

export type SessionRelationship = "owner" | "admin" | "shared";
export type SessionShareAccess = "view" | "chat";

export interface SessionCapabilities {
	view: boolean;
	chat: boolean;
	/** List and revoke shares: the owner and administrators. */
	manageShares: boolean;
	/** Create a share: only the session's owner. */
	createShares: boolean;
	configure: boolean;
}

export interface SessionShare {
	id: string;
	sessionId: string;
	granteeType: GranteeType;
	granteeId: string;
	granteeName: string | null;
	access: SessionShareAccess;
	createdByUserId: string;
	createdAt: string;
}

/** The three states of a session tree (doc/agent-runtime.md "会话状态"). */
export type SessionRunState = "idle" | "running" | "awaiting";

/** Why an `awaiting` session is blocked; the tree reports its highest-priority wait. */
export type SessionWaitingKind = "quota" | "approval" | "authorization";

/** The lightweight row of `GET /api/sessions` (doc/webui.md "SessionListItem"). */
export interface SessionListItem {
	id: string;
	/** Null until generated or set; the UI shows its localized default name (D116). */
	title: string | null;
	ownerUserId: string;
	ownerName: string;
	scheduleId: string | null;
	/** Not owned by the current user but shared with them. */
	shared: boolean;
	/** The whole tree's state: any child awaiting wins, then any running, else idle. */
	state: SessionRunState;
	/** The highest-priority wait of the tree while `state` is `awaiting`. */
	waitingKind: SessionWaitingKind | null;
	/**
	 * The tree produced output after the owner last opened it (doc/webui.md "侧边列表"). Computed for the
	 * owner only, so a shared viewer always sees false; the children list always sees false too.
	 */
	unread: boolean;
	/** The session's parent, on the children list (`GET /api/sessions/:id/children`); absent from the root list. */
	parentSessionId?: string | null;
	updatedAt: string;
}

/** The counts of a session's direct child sessions by their own state (`GET /sessions/:id/children/summary`). */
export interface SessionChildrenSummary {
	total: number;
	states: Record<SessionRunState, number>;
}

/** `visible` is the web's only scope: the caller's own roots plus the roots shared with them. */
export type SessionListScope = "mine" | "shared" | "visible" | "all";

/** One transcript entry that matched a content search (`GET /api/sessions/search`). */
export interface SessionSearchHit {
	/** The entry id in the form the transcript API uses (`EntryRecord.id`). */
	entryId: number;
	/** The session the entry belongs to; a subagent of the matched root when the hit is in a subagent. */
	sessionId: string;
	/** The owning session's title (a subagent's own title for a subagent hit); null until generated. */
	sessionTitle: string | null;
	role: "user" | "assistant";
	/** The entry message's timestamp as ISO 8601; null when the entry carries none. */
	at: string | null;
	/** About 120 characters around the first matched keyword, whitespace collapsed, cut edges marked with "…". */
	snippet: string;
}

/**
 * A root session matched by `GET /api/sessions/search`: the list item plus the title/content match details.
 * On SQLite only titles are searched, so `hits` is empty, `hitCount` is 0 and a match always has `titleMatch`.
 */
export interface SessionSearchItem extends SessionListItem {
	/** Every keyword appears in the root's title. */
	titleMatch: boolean;
	/** Entries in the whole tree that contain at least one keyword (0 on SQLite). */
	hitCount: number;
	/** Up to three matching entries, most keywords first and then newest first; empty on SQLite. */
	hits: SessionSearchHit[];
}

/** `GET /api/sessions/search`: one cursor page of matching root sessions. */
export interface SessionSearchPage {
	items: SessionSearchItem[];
	nextCursor: string | null;
	/** Whether message content was searched: true on PostgreSQL, false on SQLite (titles only). */
	contentSearch: boolean;
}

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

/** A session's own generation counters, plus the tree's input and cache-read totals (doc/agent-runtime.md "会话统计"). */
export interface SessionStats {
	/** User inputs of this session that led to at least one step. */
	turns: number;
	/** Main-agent model calls that ended in this session (retries and tool rounds included). */
	steps: number;
	/** Total time to the first streamed delta over `ttftSteps` steps. */
	ttftMs: number;
	/** Steps whose first delta was observed; 0 means no timing is known. */
	ttftSteps: number;
	/** Total decode time (message end minus first delta) over the steps that had one. */
	decodeMs: number;
	/** Output tokens decoded in `decodeMs`. */
	decodeTokens: number;
	/** Input (input + cache read + cache write) tokens of this tree's calls. */
	promptTokens: number;
	/** Cache-read tokens of this tree's calls. */
	cacheReadTokens: number;
}

/**
 * `GET /api/sessions/:id`: the session, how the caller relates to it and
 * their effective capabilities. `shares` is present only for the owner and
 * administrators (those allowed to manage shares).
 */
export interface SessionView {
	id: string;
	/** Null until generated or set; the UI shows its localized default name (D116). */
	title: string | null;
	ownerUserId: string;
	parentSessionId: string | null;
	/** The schedule whose run created this session; null for every other session. */
	scheduleId: string | null;
	model: ModelRef;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
	rules: StoredRuleSet | null;
	/** Display names for the UUIDs referenced by `rules`; null means the object was deleted. */
	refs: RefMap;
	/** How the caller relates to the session; display only, authorization uses `capabilities`. */
	relationship: SessionRelationship;
	/** Effective capabilities of the caller on this session. */
	capabilities: SessionCapabilities;
	ownerUsername: string | null;
	/** The persisted session state (doc/agent-runtime.md "会话状态"). */
	state: SessionRunState;
	/** Why the session waits while `state` is `awaiting`. */
	waitingKind: SessionWaitingKind | null;
	/** While awaiting a quota: the exhausted level to top up. */
	waitingLevelId: string | null;
	/** Remaining budget tokens (null: unlimited; negative after an overspending response). */
	budgetRemaining: number | null;
	/** The budget measure: output tokens spent by the session and its subagents (D101). */
	budgetUsedTokens: number;
	/** The statistics measure: input + output tokens of the session and its subagents (D101). */
	usageTokens: number;
	/** The input size of the session's own last main-agent call; null before the first (D101). */
	contextTokens: number | null;
	/** The session's own generation statistics; the token totals cover its whole tree. */
	stats: SessionStats;
	shares?: SessionShare[];
}

/** Body of `PATCH /api/sessions/:id`; omitted fields stay unchanged, null clears. */
export interface SessionPatch {
	title?: string;
	model?: ModelRef;
	rulePreset?: RulePreset;
	/** Replaces the remaining budget at any level (null: unlimited). */
	budgetRemaining?: number | null;
}

/** A root whose token quota is used up and waits for the owner's decision (doc/agent-runtime.md "配额"). */
export interface QuotaApproval {
	/** The root session to act on (and to link to). */
	sessionId: string;
	/** The exhausted level to top up; the root. */
	levelId: string;
	/** Null when the session has no title yet; show the localized default name. */
	title: string | null;
	since: string;
	/** Remaining budget tokens at the level; zero or negative (D101). */
	budgetRemaining: number;
	/** The budget measure spent by the tree (D101). */
	budgetUsedTokens: number;
}

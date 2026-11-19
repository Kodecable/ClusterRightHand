/**
 * Runtime schemas for the session routes (`../sessions.ts`, doc/design/webui.md "Session list API",
 * doc/design/access-control.md "Ownership, access grants and sharing",
 * doc/design/agent-runtime.md "Quota and token accounting"). The wire types in `../sessions.ts` are derived
 * from them, so a handler and the API document cannot drift.
 */
import { z } from "zod";
import { SESSION_TITLE_MAX_CHARS } from "../sessions.ts";
import { cursorPageSchema, RefMapSchema } from "./common.ts";
import { SessionExtensionSchema } from "./extensions.ts";
import { ModelRefSchema } from "./models.ts";
import { RulePresetSchema, StoredRuleSetSchema } from "./policy.ts";

/**
 * A user-set session title, at most `SESSION_TITLE_MAX_CHARS` code points. `.max()` counts UTF-16 code
 * units, so an emoji would use two of the budget; the refine counts what a reader sees.
 */
const SessionTitleSchema = z
	.string()
	.refine((value) => Array.from(value).length <= SESSION_TITLE_MAX_CHARS, {
		message: `A session title is at most ${SESSION_TITLE_MAX_CHARS} characters.`,
	})
	.describe(`The session title, at most ${SESSION_TITLE_MAX_CHARS} characters (counted in Unicode code points).`);

/** The state of a session tree (doc/design/agent-runtime.md "Session state"). */
export const SessionRunStateSchema = z.enum(["idle", "running", "awaiting"]);

/** Why an `awaiting` session is blocked; the tree reports its highest-priority wait (doc/design/agent-runtime.md). */
export const SessionWaitingKindSchema = z.enum(["quota", "approval", "authorization"]);

/** The scopes of the session list and its search; `all` is administrators only. */
export const SessionListScopeSchema = z.enum(["mine", "shared", "visible", "all"]);

/** How the caller relates to a session; display only, authorization uses `capabilities`. */
export const SessionRelationshipSchema = z.enum(["owner", "admin", "shared"]);

export const SessionShareAccessSchema = z.enum(["view", "chat"]);

export const SessionCapabilitiesSchema = z
	.object({
		view: z.boolean(),
		chat: z.boolean(),
		manageShares: z.boolean().describe("List and revoke shares: the owner and administrators."),
		createShares: z.boolean().describe("Create a share: only the session's owner."),
		configure: z.boolean(),
	})
	.meta({ id: "SessionCapabilities" });

/** One share of a session (doc/design/access-control.md "Ownership, access grants and sharing"). */
export const SessionShareSchema = z
	.object({
		id: z.string(),
		sessionId: z.string(),
		granteeType: z.enum(["user", "user_group"]),
		granteeId: z.string(),
		granteeName: z.string().nullable(),
		access: SessionShareAccessSchema,
		createdByUserId: z.string(),
		createdAt: z.string(),
	})
	.meta({ id: "SessionShare" });

/** The lightweight row of `GET /api/sessions` and `GET /api/sessions/{id}/children` (doc/design/webui.md). */
export const SessionListItemSchema = z
	.object({
		id: z.string(),
		title: z.string().nullable().describe("Null until generated or set; the UI shows its localized default name."),
		ownerUserId: z.string(),
		ownerName: z.string(),
		scheduleId: z.string().nullable(),
		shared: z.boolean().describe("Not owned by the current user but shared with them."),
		state: SessionRunStateSchema.describe("The whole tree's state: any child awaiting wins, then running, else idle."),
		waitingKind: SessionWaitingKindSchema.nullable().describe("The highest-priority wait while `state` is awaiting."),
		unread: z.boolean().describe("The tree produced output after the owner last opened it; false for a shared viewer."),
		parentSessionId: z.string().nullable().optional().describe("Present on the children list; absent from roots."),
		updatedAt: z.string(),
	})
	.meta({ id: "SessionListItem" });

/** `GET /api/sessions` and `GET /api/sessions/{id}/children`: one cursor page of list items. */
export const SessionListResponseSchema = cursorPageSchema(SessionListItemSchema).meta({ id: "SessionListResponse" });

/** One transcript entry that matched a content search (`GET /api/sessions/search`). */
export const SessionSearchHitSchema = z
	.object({
		entryId: z.number().describe("The entry id in the form the transcript API uses."),
		sessionId: z.string().describe("The session the entry belongs to; a subagent of the matched root when in one."),
		sessionTitle: z.string().nullable().describe("The owning session's title; null until generated."),
		role: z.enum(["user", "assistant"]),
		at: z.string().nullable().describe("The message's timestamp as ISO 8601; null when it has none."),
		snippet: z
			.string()
			.describe('About 120 characters around the first matched keyword, whitespace collapsed, cut edges marked "…".'),
	})
	.meta({ id: "SessionSearchHit" });

/**
 * A root session matched by `GET /api/sessions/search`: the list item plus the title/content match details.
 * On SQLite only titles are searched, so `hits` is empty, `hitCount` is 0 and a match always has `titleMatch`.
 */
export const SessionSearchItemSchema = SessionListItemSchema.extend({
	titleMatch: z.boolean().describe("Every keyword appears in the root's title."),
	hitCount: z.number().describe("Entries in the whole tree that contain at least one keyword (0 on SQLite)."),
	hits: z
		.array(SessionSearchHitSchema)
		.describe("Up to three matching entries, most keywords first and then newest first; empty on SQLite."),
}).meta({ id: "SessionSearchItem" });

/** `GET /api/sessions/search`: one cursor page of matching root sessions. */
export const SessionSearchResponseSchema = z
	.object({
		items: z.array(SessionSearchItemSchema),
		nextCursor: z.string().nullable().describe("Pass as `cursor` for the next page; null on the last one."),
		contentSearch: z.boolean().describe("Whether message content was searched: true on PostgreSQL, false on SQLite."),
	})
	.meta({ id: "SessionSearchResponse" });

/** One session's own generation counters, plus the tree's input and cache-read totals (doc/design/agent-runtime.md "Session statistics"). */
export const SessionStatsSchema = z
	.object({
		turns: z.number().describe("User inputs of this session that led to at least one step."),
		steps: z.number().describe("Main-agent model calls that ended in this session (retries and tool rounds included)."),
		ttftMs: z.number().describe("Total time to the first streamed delta over `ttftSteps` steps."),
		ttftSteps: z.number().describe("Steps whose first delta was observed; 0 means no timing is known."),
		decodeMs: z.number().describe("Total decode time over the steps that had one."),
		decodeTokens: z.number().describe("Output tokens decoded in `decodeMs`."),
		promptTokens: z.number().describe("Input (input + cache read + cache write) tokens of this tree's calls."),
		cacheReadTokens: z.number().describe("Cache-read tokens of this tree's calls."),
	})
	.meta({ id: "SessionStats" });

/**
 * Where a forked session came from (doc/design/agent-runtime.md "Forking"): the source session, the final
 * reply its history ends at, and the source title resolved for display. Null on every session that is not a
 * fork, and on a fork whose source the caller cannot see or that has been deleted.
 */
export const SessionForkedFromSchema = z
	.object({
		sessionId: z.string().describe("The source session's id."),
		title: z
			.string()
			.describe('The source session title as the caller sees it; an untitled source reads as "New session".'),
		entryId: z.number().describe("The source's final reply entry the fork's history ends at, inclusively."),
	})
	.meta({ id: "SessionForkedFrom" });

/**
 * `GET /api/sessions/{id}`: the session, how the caller relates to it and their effective capabilities.
 * `extensions` lists the extensions the session may use with the owner's on/off choice.
 */
export const SessionViewSchema = z
	.object({
		id: z.string(),
		title: z.string().nullable().describe("Null until generated or set; the UI shows its localized default name."),
		ownerUserId: z.string(),
		parentSessionId: z.string().nullable(),
		scheduleId: z
			.string()
			.nullable()
			.describe("The schedule whose run created this session; null for every other session."),
		model: ModelRefSchema,
		status: z.enum(["active", "archived"]),
		createdAt: z.string(),
		updatedAt: z.string(),
		rules: StoredRuleSetSchema.nullable(),
		refs: RefMapSchema.describe("Display names for the ids `rules` references; null means deleted."),
		relationship: SessionRelationshipSchema,
		capabilities: SessionCapabilitiesSchema.describe("Effective capabilities of the caller on this session."),
		ownerUsername: z.string().nullable(),
		state: SessionRunStateSchema.describe("The persisted session state."),
		waitingKind: SessionWaitingKindSchema.nullable().describe("Why the session waits while `state` is `awaiting`."),
		waitingLevelId: z.string().nullable().describe("While awaiting a quota: the exhausted level to top up."),
		budgetRemaining: z.number().nullable().describe("Remaining budget tokens; null means unlimited."),
		budgetUsedTokens: z.number().describe("The budget measure: output tokens spent by the session and its subagents."),
		usageTokens: z.number().describe("The statistics measure: input + output tokens of the session and its subagents."),
		contextTokens: z.number().nullable().describe("The input size of the session's own last main-agent call."),
		stats: SessionStatsSchema.describe("The session's own generation statistics; token totals cover its whole tree."),
		forkedFrom: SessionForkedFromSchema.nullable().describe(
			"The source of a fork; null for every other session and when the caller cannot see the source.",
		),
		extensions: z.array(SessionExtensionSchema).optional(),
		shares: z.array(SessionShareSchema).optional(),
	})
	.meta({ id: "SessionView" });

/** `GET /api/sessions/{id}`: the session and, for the owner and administrators, its shares. */
export const SessionDetailResponseSchema = z
	.object({
		session: SessionViewSchema,
		shares: z.array(SessionShareSchema).optional().describe("Present only when the caller may manage shares."),
	})
	.meta({ id: "SessionDetailResponse" });

/** `POST /api/sessions` and `PATCH /api/sessions/{id}`: the session as the caller sees it. */
export const SessionResponseSchema = z.object({ session: SessionViewSchema });

/** `GET /api/sessions/{id}/children/summary`: the direct children's own states, for the compact children bar. */
export const SessionChildrenSummarySchema = z
	.object({
		total: z.number(),
		states: z.object({ idle: z.number(), running: z.number(), awaiting: z.number() }),
	})
	.meta({ id: "SessionChildrenSummary" });

/** `GET /api/sessions/{id}/shares`: the session's shares, for the owner and administrators. */
export const SessionSharesResponseSchema = z.object({ shares: z.array(SessionShareSchema) });

/** `PUT /api/sessions/{id}/shares`: the share that was added, or its existing row strengthened. */
export const SessionShareResponseSchema = z.object({ share: SessionShareSchema });

/** `POST /api/sessions/{id}/messages`: the accepted submission, whose answer arrives on the event stream. */
export const SessionMessageResponseSchema = z.object({ submissionId: z.string() });

/** `POST /api/sessions/{id}/compact`: the compaction task and what it did. */
export const SessionCompactResponseSchema = z
	.object({
		taskId: z.string(),
		outcome: z.enum(["started", "nothing", "failed"]).describe("`nothing` when durable found nothing old enough."),
	})
	.meta({ id: "SessionCompactResponse" });

/** `POST /api/sessions/{id}/quota`: the decision was recorded; these sessions left their quota wait. */
export const SessionQuotaResponseSchema = z.object({ ok: z.literal(true), sessions: z.array(z.string()) });

/** `GET /api/sessions/{id}/entries`: one page of older entries, oldest first. */
export const SessionEntrySchema = z
	.object({
		id: z
			.union([z.string(), z.number()])
			.describe("The conversation's commit order; a mock transcript may use strings."),
		kind: z.string(),
		model: z.array(z.unknown()).optional().describe("The model-facing messages the entry contributes."),
		data: z.unknown().optional().describe("Application payload of the entry kind."),
	})
	.meta({ id: "SessionEntry" });

export const SessionEntriesResponseSchema = z
	.object({
		entries: z.array(SessionEntrySchema),
		historyCursor: z.string().nullable(),
	})
	.meta({ id: "SessionEntriesResponse" });

/** One attachment the composer uploads to the owner's library or picks from it (doc/design/library.md "Chat attachments"). */
export const ChatAttachmentInputSchema = z.object({
	library: z.string().describe("`user:<username>` or `user_group:<user group name>`."),
	path: z.string().describe("The path inside that library."),
});

/** `POST /api/sessions`: creates a session and submits its first message in one request. */
export const SessionCreateBodySchema = z.object({
	requestId: z.string().describe("Makes a retried create return the first attempt's session; at most 128 characters."),
	model: ModelRefSchema,
	message: z.string(),
	rulePreset: RulePresetSchema.optional().describe('The starting rules; "ask" by default.'),
	budgetRemaining: z
		.number()
		.nullable()
		.optional()
		.describe("The root's remaining budget in tokens; null or absent is unlimited."),
	title: SessionTitleSchema.optional(),
	attachments: z.array(ChatAttachmentInputSchema).optional(),
	timeZone: z
		.string()
		.optional()
		.describe(
			"The sender's IANA time zone, such as `Asia/Shanghai`; the model reads the message's sent time in it. Absent or unknown: the server's time zone.",
		),
	disabledExtensions: z
		.array(z.string())
		.optional()
		.describe("The extensions to start the session with off; omitted means all available extensions are on."),
});

/** `PATCH /api/sessions/{id}`; omitted fields stay unchanged, null clears. */
export const SessionPatchBodySchema = z.object({
	title: SessionTitleSchema.optional(),
	model: ModelRefSchema.optional(),
	rulePreset: RulePresetSchema.optional(),
	budgetRemaining: z
		.number()
		.nullable()
		.optional()
		.describe("Replaces the remaining budget at any level; null is unlimited."),
	disabledExtensions: z.array(z.string()).optional().describe("The extensions the owner turned off."),
});

/** `POST /api/sessions/{id}/messages`: the user's message; `requestId` makes a retried send land once. */
export const SessionMessageBodySchema = z.object({
	text: z.string(),
	requestId: z.string(),
	attachments: z.array(ChatAttachmentInputSchema).optional(),
	timeZone: z
		.string()
		.optional()
		.describe(
			"The sender's IANA time zone, such as `Asia/Shanghai`; the model reads the message's sent time in it. Absent or unknown: the server's time zone.",
		),
});

/**
 * `POST /api/sessions/{id}/fork`: the final reply to fork at, and the client request id that makes a retried
 * fork return the first fork instead of creating another (doc/design/agent-runtime.md "Forking").
 */
export const SessionForkBodySchema = z.object({
	entryId: z.number().int().describe("The source's final reply entry: an assistant message without tool calls."),
	requestId: z.string().describe("Makes a retried fork return the first fork; at most 128 characters."),
});

/** `POST /api/sessions/{id}/compact`: an optional instruction for the summary. */
export const SessionCompactBodySchema = z.object({
	instructions: z.string().optional().describe("What the summary should keep; at most 2000 characters."),
});

/** `POST /api/sessions/{id}/quota`: the owner's answer when a root's budget is used up. */
export const SessionQuotaBodySchema = z.object({
	decision: z.enum(["approve", "deny"]),
	tokens: z.number().optional().describe("The tokens to add; a positive integer, required when approving."),
	reason: z.string().optional().describe("Recorded in the audit log; at most 1000 characters."),
});

/** `PUT /api/sessions/{id}/shares`: one grantee and the access it gets. */
export const SessionShareBodySchema = z.object({
	granteeType: z.enum(["user", "user_group"]),
	granteeId: z.string(),
	access: SessionShareAccessSchema,
});

/** Query parameters of `GET /api/sessions`; values are strings (doc/design/webui.md "API conventions"). */
export const SessionListQuerySchema = z.object({
	scope: z.string().optional().describe("`mine` (default), `shared`, `visible` or `all` (administrators only)."),
	q: z.string().optional().describe("Case-insensitive title substring."),
	scheduleId: z.string().optional(),
	ownerId: z.string().optional().describe("Only roots owned by this user; `all` is administrators only."),
	cursor: z.string().optional().describe("The `nextCursor` of the previous page."),
	limit: z.string().optional().describe("Page size, 1 to 200; 50 by default."),
});

/** Query parameters of `GET /api/sessions/search`. */
export const SessionSearchQuerySchema = z.object({
	q: z.string().optional().describe("Whitespace-separated keywords, at most 8; every keyword must match."),
	scope: z.string().optional().describe("Same scopes as the session list; default `mine`."),
	cursor: z.string().optional(),
	limit: z.string().optional().describe("Page size, 1 to 50; 20 by default."),
});

/** Query parameters of the children list. */
export const SessionChildrenQuerySchema = z.object({
	cursor: z.string().optional(),
	limit: z.string().optional(),
});

/** Query parameters of `GET /api/sessions/{id}/entries`. */
export const SessionEntriesQuerySchema = z.object({
	before: z.string().optional().describe("The snapshot's or the previous page's `historyCursor`."),
	limit: z.string().optional().describe("Page size, 1 to 200; 100 by default."),
});

/** Query parameter of the event streams; omitted keeps the historical audience (all administrators). */
export const SessionEventStreamQuerySchema = z.object({
	scope: z.string().optional().describe("`mine`, `shared`, `visible` or `all` (administrators only)."),
});

/** Path parameters of the session routes. */
export const SessionIdParamSchema = z.object({ id: z.string() });

/** Path parameters of `DELETE /api/sessions/{id}/shares/{shareId}`. */
export const SessionShareParamSchema = z.object({ id: z.string(), shareId: z.string() });

/** A root session whose quota is used up and waits for its owner (doc/design/agent-runtime.md). */
export const QuotaApprovalSchema = z
	.object({
		sessionId: z.string().describe("The root session to act on (and to link to)."),
		levelId: z.string().describe("The exhausted level to top up; the root."),
		title: z.string().nullable().describe("Null when the session has no title yet."),
		since: z.string(),
		budgetRemaining: z.number().describe("Remaining budget tokens at the level; zero or negative."),
		budgetUsedTokens: z.number().describe("The budget measure spent by the tree."),
	})
	.meta({ id: "QuotaApproval" });

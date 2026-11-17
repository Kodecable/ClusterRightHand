import type { SessionView as ApiSessionView, SessionEntry } from "@crh/api";
import {
	ErrorResponseSchema,
	OkResponseSchema,
	SessionChildrenQuerySchema,
	SessionChildrenSummarySchema,
	SessionCompactBodySchema,
	SessionCompactResponseSchema,
	SessionCreateBodySchema,
	SessionDetailResponseSchema,
	SessionEntriesQuerySchema,
	SessionEntriesResponseSchema,
	SessionExtensionsResponseSchema,
	SessionForkBodySchema,
	SessionIdParamSchema,
	SessionListQuerySchema,
	SessionListResponseSchema,
	SessionMessageBodySchema,
	SessionMessageResponseSchema,
	SessionPatchBodySchema,
	SessionQuotaBodySchema,
	SessionQuotaResponseSchema,
	SessionResponseSchema,
	SessionSearchQuerySchema,
	SessionSearchResponseSchema,
	SessionShareBodySchema,
	SessionShareParamSchema,
	SessionShareResponseSchema,
	SessionSharesResponseSchema,
} from "@crh/api/schemas";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { parseModelRef } from "../agent/models.ts";
import { parseQuota } from "../agent/quota.ts";
import type { AgentRuntime, SessionView } from "../agent/runtime.ts";
import {
	type SessionListScope,
	sessionChildItem,
	sessionChildrenQuery,
	sessionListCursor,
	sessionListItem,
	sessionListQuery,
	shareAudienceUserIds,
} from "../agent/session-list.ts";
import { parseSearchKeywords, parseSearchLimit, sessionSearch } from "../agent/session-search.ts";
import { userActor } from "../audit/audit.ts";
import { isAdmin, type SessionUser } from "../auth/sessions.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { parseDisabledExtensions } from "../extensions/store.ts";
import { parseRulePreset } from "../policy/store.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { type AttachmentLimits, attachmentContent, resolveAttachments } from "../sessions/attachments.ts";
import { rootSessionIdOf } from "../sessions/session-chain.ts";
import {
	capabilitiesFor,
	listSessionShares,
	type SessionPermissions,
	sessionCapabilities,
	sharedSessionAccess,
	shareSession,
	unshareSession,
} from "../sessions/sharing.ts";
import { displayedSessionTitle } from "../sessions/titles.ts";
import type { SettingsStore } from "../settings/settings.ts";
import { DEFAULT_ATTACHMENT_INLINE_TEXT_BYTES, DEFAULT_ATTACHMENT_INLINE_TOTAL_BYTES } from "../settings/settings.ts";
import type { Db } from "../storage/db.ts";
import { usernamesById } from "../users/service.ts";
import { getUserSettings } from "../users/settings.ts";
import { type CursorSpec, cursorRows, decodeCursor, parseLimit } from "../util/cursor.ts";
import { NotFoundError, UserError } from "../util/errors.ts";
import { reevaluateAfterRuleChange } from "./approval-routes.ts";
import type { AppEnv } from "./context.ts";
import { apiRouter, defineRoute, json } from "./openapi.ts";
import type { SessionStreams } from "./session-events-routes.ts";

const TAGS = ["Sessions"];

export interface SessionRoutesOptions {
	runtime: AgentRuntime;
	cluster: Cluster;
	taskGroups: TaskGroups;
	/** The open event streams: removing a share may end some of them. */
	streams: SessionStreams;
	/** Tells the scheduler when a scheduled run's root quota was denied, so the run ends failed (doc/design/scheduling.md). */
	scheduler?: Scheduler;
	/** The attachment inline limits; the defaults apply without a store (tests). */
	settings?: SettingsStore;
}

/**
 * The cursor of both session lists (`GET /sessions` and `GET /sessions/:id/children`):
 * `updated_at desc, id desc`.
 */
const SESSION_CURSOR: CursorSpec = {
	columns: [{ name: "sessions.updated_at", type: "string" }],
	idType: "string",
	idColumn: "sessions.id",
};
/** A history cursor is just the entry id to stop before, so it needs no sort column. */
const HISTORY_CURSOR: CursorSpec = { columns: [], idType: "number" };
/** History pages default to 100 entries (doc/design/webui.md "Session event stream and history"). */
const DEFAULT_HISTORY = 100;
/** The scopes of the session list and of its stream. */
export const SESSION_SCOPES: ReadonlySet<string> = new Set(["mine", "shared", "visible", "all"]);

/** A session the caller can see, with their capabilities on it. */
export type VisibleSession = { session: SessionView } & SessionPermissions;

/** The session and its capabilities for the user; undefined when they cannot see it. */
export async function visibleSession(
	db: Db,
	runtime: AgentRuntime,
	user: SessionUser,
	id: string,
): Promise<VisibleSession | undefined> {
	const info = await sessionCapabilities(db, user, id);
	if (!info) return undefined;
	const session = await runtime.getSession(id);
	return session ? { session, ...info } : undefined;
}

/**
 * Shutdown closes the runtime before the drain is idle (main.ts): a session request still in flight must
 * fail with a normal error instead of reaching the closed Harness. Registered on `/sessions` and
 * `/sessions/*` before any session route.
 */
export function refuseWhenClosing(runtime: AgentRuntime): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (runtime.closing) return c.json({ error: "server is shutting down" }, 503);
		await next();
	};
}

const listRoute = defineRoute({
	method: "get",
	path: "/sessions",
	tags: TAGS,
	summary: "Page through root sessions, newest activity first; `scope=all` is administrators only",
	agent: "allow",
	request: { query: SessionListQuerySchema },
	responses: {
		200: { description: "One page of root sessions", ...json(SessionListResponseSchema) },
		403: { description: "`scope=all` is administrators only", ...json(ErrorResponseSchema) },
	},
});

const searchRoute = defineRoute({
	method: "get",
	path: "/sessions/search",
	tags: TAGS,
	summary: "Search root sessions by title and (on PostgreSQL) message text, newest activity first",
	agent: "allow",
	request: { query: SessionSearchQuerySchema },
	responses: {
		200: { description: "One page of matching root sessions and their hits", ...json(SessionSearchResponseSchema) },
		403: { description: "`scope=all` is administrators only", ...json(ErrorResponseSchema) },
	},
});

const createRoute = defineRoute({
	method: "post",
	path: "/sessions",
	tags: TAGS,
	summary: "Create a session and submit its first message; a repeated `requestId` returns the first session",
	agent: "deny", // it would create a Yolo or unlimited session past the session guardrails
	request: { body: { required: true, ...json(SessionCreateBodySchema) } },
	responses: {
		201: { description: "The new session", ...json(SessionResponseSchema) },
		200: { description: "The session a repeated request created before", ...json(SessionResponseSchema) },
	},
});

/**
 * The draft page's list before a session exists (doc/design/extensions.md "Extensions"): the same resolution a
 * created session's `extensions` uses for the caller, with every entry on. Registered before `/sessions/{id}` so
 * its static path is not taken for a session id.
 */
const extensionsRoute = defineRoute({
	method: "get",
	path: "/sessions/extensions",
	tags: TAGS,
	summary: "The extensions a new session of the caller reaches, all of them on",
	agent: "allow",
	responses: { 200: { description: "The available extensions", ...json(SessionExtensionsResponseSchema) } },
});

const getRoute = defineRoute({
	method: "get",
	path: "/sessions/{id}",
	tags: TAGS,
	summary: "One session, the caller's relationship and capabilities, and the shares they may manage",
	agent: "allow",
	request: { params: SessionIdParamSchema },
	responses: { 200: { description: "The session", ...json(SessionDetailResponseSchema) } },
});

const readRoute = defineRoute({
	method: "post",
	path: "/sessions/{id}/read",
	tags: TAGS,
	summary: "Mark a session tree read for its owner; `:id` may be any session of the tree",
	agent: "ask", // a mutation, if a harmless one
	request: { params: SessionIdParamSchema },
	responses: { 204: { description: "Marked read" } },
});

const childrenRoute = defineRoute({
	method: "get",
	path: "/sessions/{id}/children",
	tags: TAGS,
	summary: "Page through a session's direct child sessions, newest activity first",
	agent: "allow",
	request: { params: SessionIdParamSchema, query: SessionChildrenQuerySchema },
	responses: { 200: { description: "One page of child sessions", ...json(SessionListResponseSchema) } },
});

const childrenSummaryRoute = defineRoute({
	method: "get",
	path: "/sessions/{id}/children/summary",
	tags: TAGS,
	summary: "How many direct child sessions the session has, by their own state",
	agent: "allow",
	request: { params: SessionIdParamSchema },
	responses: { 200: { description: "The child counts", ...json(SessionChildrenSummarySchema) } },
});

const sharesRoute = defineRoute({
	method: "get",
	path: "/sessions/{id}/shares",
	tags: TAGS,
	summary: "The session's shares (the owner and administrators)",
	agent: "allow",
	request: { params: SessionIdParamSchema },
	responses: {
		200: { description: "The shares", ...json(SessionSharesResponseSchema) },
		403: { description: "The owner or an administrator", ...json(ErrorResponseSchema) },
	},
});

const addShareRoute = defineRoute({
	method: "put",
	path: "/sessions/{id}/shares",
	tags: TAGS,
	summary: "Share a session with a user or a user group (only the owner)",
	agent: "deny", // sharing changes who can see and drive the session
	request: { params: SessionIdParamSchema, body: { required: true, ...json(SessionShareBodySchema) } },
	responses: {
		200: { description: "The added or strengthened share", ...json(SessionShareResponseSchema) },
		403: { description: "Only the owner can share this session", ...json(ErrorResponseSchema) },
	},
});

const removeShareRoute = defineRoute({
	method: "delete",
	path: "/sessions/{id}/shares/{shareId}",
	tags: TAGS,
	summary: "Revoke one session share (the owner and administrators)",
	agent: "deny", // sharing changes who can see and drive the session
	request: { params: SessionShareParamSchema },
	responses: {
		200: { description: "Revoked", ...json(OkResponseSchema) },
		403: { description: "The owner or an administrator", ...json(ErrorResponseSchema) },
	},
});

const patchRoute = defineRoute({
	method: "patch",
	path: "/sessions/{id}",
	tags: TAGS,
	summary: "Change a session's title, model, rule preset, budget or disabled extensions (only the owner)",
	agent: "deny", // rule presets and the budget are guardrails
	request: { params: SessionIdParamSchema, body: { required: true, ...json(SessionPatchBodySchema) } },
	responses: {
		200: { description: "The updated session", ...json(SessionResponseSchema) },
		403: { description: "The owner only", ...json(ErrorResponseSchema) },
	},
});

const messagesRoute = defineRoute({
	method: "post",
	path: "/sessions/{id}/messages",
	tags: TAGS,
	summary: "Submit a user message; `requestId` makes a retried send land once",
	agent: "deny", // it would drive another session past the session guardrails
	request: { params: SessionIdParamSchema, body: { required: true, ...json(SessionMessageBodySchema) } },
	responses: {
		202: { description: "The accepted submission", ...json(SessionMessageResponseSchema) },
		403: { description: "Chat access is required, or only the owner may attach files", ...json(ErrorResponseSchema) },
	},
});

const compactRoute = defineRoute({
	method: "post",
	path: "/sessions/{id}/compact",
	tags: TAGS,
	summary: "Start a manual context compaction; the summary is made in the background",
	agent: "ask",
	request: {
		params: SessionIdParamSchema,
		body: { required: false, ...json(SessionCompactBodySchema) },
	},
	responses: {
		202: { description: "The compaction task and its outcome", ...json(SessionCompactResponseSchema) },
		403: { description: "Chat access is required", ...json(ErrorResponseSchema) },
	},
});

const forkRoute = defineRoute({
	method: "post",
	path: "/sessions/{id}/fork",
	tags: TAGS,
	summary: "Fork a session at one of its final replies into a new root; a repeated `requestId` returns the first fork",
	agent: "deny", // a fork starts a new root with no quota, past the session guardrails
	request: { params: SessionIdParamSchema, body: { required: true, ...json(SessionForkBodySchema) } },
	responses: {
		201: { description: "The new forked session", ...json(SessionResponseSchema) },
		200: { description: "The session a repeated request forked before", ...json(SessionResponseSchema) },
		403: { description: "The owner only", ...json(ErrorResponseSchema) },
	},
});

const quotaRoute = defineRoute({
	method: "post",
	path: "/sessions/{id}/quota",
	tags: TAGS,
	summary: "Decide a used-up root token quota: add tokens or deny (only the owner)",
	agent: "deny", // raising a budget is a guardrail decision
	request: { params: SessionIdParamSchema, body: { required: true, ...json(SessionQuotaBodySchema) } },
	responses: {
		200: {
			description: "The decision was recorded; these sessions left their quota wait",
			...json(SessionQuotaResponseSchema),
		},
		403: { description: "The owner only", ...json(ErrorResponseSchema) },
	},
});

const abortRoute = defineRoute({
	method: "post",
	path: "/sessions/{id}/abort",
	tags: TAGS,
	summary: "Stop the session's run",
	agent: "ask",
	request: { params: SessionIdParamSchema },
	responses: {
		200: { description: "Stopped", ...json(OkResponseSchema) },
		403: { description: "Chat access is required", ...json(ErrorResponseSchema) },
	},
});

const entriesRoute = defineRoute({
	method: "get",
	path: "/sessions/{id}/entries",
	tags: TAGS,
	summary: "Page through the shown entries immediately before a history cursor, oldest first",
	agent: "allow",
	request: { params: SessionIdParamSchema, query: SessionEntriesQuerySchema },
	responses: {
		200: { description: "One page of older entries", ...json(SessionEntriesResponseSchema) },
	},
});

/**
 * Sessions (chat with the agent); doc/design/agent-runtime.md. Expects requireUser and refuseWhenClosing; the
 * event streams are in session-events-routes.ts, registered first.
 */
export function sessionRoutes(db: Db, options: SessionRoutesOptions) {
	const { runtime, streams } = options;
	const app = apiRouter();

	const attachmentLimits = (): AttachmentLimits => {
		const configured = options.settings?.current().attachments;
		return {
			inlineTextBytes: configured?.inlineTextBytes ?? DEFAULT_ATTACHMENT_INLINE_TEXT_BYTES,
			inlineTotalBytes: configured?.inlineTotalBytes ?? DEFAULT_ATTACHMENT_INLINE_TOTAL_BYTES,
		};
	};

	// ---- sessions: the owner, users it is shared with (view / chat), and administrators (view unless shared chat) ----

	/** The session and its capabilities for the caller; undefined when they cannot see it. */
	const visible = (c: Context<AppEnv>, id: string): Promise<VisibleSession | undefined> =>
		visibleSession(db, runtime, c.get("user"), id);
	/** A capability that gates a session route, and the 403 each one answers with. */
	const CAPABILITY_DENIED = {
		chat: "chat access is required",
		manageShares: "the owner or an administrator",
		createShares: "only the owner can share this session",
		configure: "the owner only",
	} as const;
	/**
	 * The session and the caller's capabilities, or the error the route answers with: the visibility 404,
	 * then the capability's 403. `"owner"` is the owner-only check for the paths no capability names
	 * exactly (the root quota decision and marking read), answered "the owner only" like `configure`.
	 */
	const requireSession = async (
		c: Context<AppEnv>,
		id: string,
		capability?: keyof typeof CAPABILITY_DENIED | "owner",
	): Promise<VisibleSession> => {
		const v = await visible(c, id);
		if (!v) throw new NotFoundError("no such session");
		if (capability === undefined) return v;
		if (capability === "owner") {
			if (v.session.ownerUserId !== c.get("user").userId) {
				throw new HTTPException(403, { message: "the owner only" });
			}
			return v;
		}
		if (!v.capabilities[capability]) throw new HTTPException(403, { message: CAPABILITY_DENIED[capability] });
		return v;
	};
	const decorate = async (c: Context<AppEnv>, views: SessionView[]): Promise<ApiSessionView[]> => {
		const user = c.get("user");
		const names = await usernamesById(db, [...new Set(views.map((v) => v.ownerUserId))]);
		const shared = await sharedSessionAccess(db, user.userId);
		// A fork's source title is resolved for the caller, and only when they may see the source. The source may
		// have been deleted, so a missing row also reads as no origin (doc/design/agent-runtime.md "Forking").
		const sourceIds = [...new Set(views.flatMap((v) => (v.forkedFrom ? [v.forkedFrom.sessionId] : [])))];
		const forkTitles = new Map<string, string>();
		if (sourceIds.length > 0) {
			const locale = (await getUserSettings(db, user.userId)).locale;
			const sources = await db.selectFrom("sessions").select(["id", "title"]).where("id", "in", sourceIds).execute();
			for (const source of sources) {
				if (await sessionCapabilities(db, user, source.id)) {
					forkTitles.set(source.id, displayedSessionTitle(source.title, locale));
				}
			}
		}
		return views.map((v) => {
			const isOwner = v.ownerUserId === user.userId;
			const admin = isAdmin(user);
			const share = shared.get(v.id);
			const { forkedFrom, ...rest } = v;
			const title = forkedFrom === null ? undefined : forkTitles.get(forkedFrom.sessionId);
			return {
				...rest,
				forkedFrom:
					forkedFrom === null || title === undefined
						? null
						: { sessionId: forkedFrom.sessionId, title, entryId: forkedFrom.entryId },
				relationship: isOwner ? ("owner" as const) : admin ? ("admin" as const) : ("shared" as const),
				capabilities: capabilitiesFor(isOwner, admin, share),
				ownerUsername: names.get(v.ownerUserId) ?? null,
			};
		});
	};
	const decorateOne = async (c: Context<AppEnv>, session: SessionView): Promise<ApiSessionView> => {
		const [view] = await decorate(c, [session]);
		if (!view) throw new NotFoundError("no such session");
		return view;
	};

	/**
	 * Root sessions as `SessionListItem`, newest activity first, one keyset page at a time
	 * (doc/design/webui.md "Session list API"). `scope=all` is administrators only; `shared` means a share reaches the caller,
	 * not ownership; `visible` is the owner-and-shared union the WebUI lists. Default `mine`. `GET /sessions/:id`
	 * stays the full SessionView.
	 */
	app.openapi(listRoute, async (c) => {
		const user = c.get("user");
		const query = c.req.valid("query");
		const scope = query.scope ?? "mine";
		if (!SESSION_SCOPES.has(scope)) throw new UserError("scope must be mine, shared, visible or all");
		if (scope === "all" && !isAdmin(user)) throw new HTTPException(403, { message: "administrators only" });
		const limit = parseLimit(query.limit);
		const rawCursor = query.cursor;
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, SESSION_CURSOR);
		const q = query.q;
		const scheduleId = query.scheduleId;
		const ownerId = query.ownerId;
		const page = await cursorRows(
			limit,
			async (limitPlusOne) =>
				(
					await sessionListQuery(db, user, {
						scope: scope as SessionListScope,
						...(q ? { q } : {}),
						...(scheduleId === undefined ? {} : { scheduleId }),
						...(ownerId === undefined ? {} : { ownerId }),
						...(cursor ? { cursor } : {}),
					})
				)
					.limit(limitPlusOne)
					.execute(),
			(row) => sessionListCursor(row.updated_at, row.id),
		);
		return c.json(
			{
				// The query's `shared` EXISTS is 0/1 on SQLite and a boolean on PostgreSQL.
				items: page.rows.map((row) => sessionListItem(row, user.userId, Boolean(row.shared))),
				nextCursor: page.nextCursor,
			},
			200,
		);
	});

	/**
	 * Root sessions matching every whitespace-separated keyword of `q` in their title or message text, newest
	 * activity first, one keyset page at a time (doc/design/webui.md "Session content search"). Titles are searched on both backends;
	 * message content only on PostgreSQL, where the pg-durable adapter's generated `search_text` column exists.
	 * So SQLite answers `contentSearch: false` and never fills `hits` or `hitCount`. The scope, visibility and
	 * cursor are the session list's. Registered before `/sessions/:id`, which would otherwise read "search" as an id.
	 */
	app.openapi(searchRoute, async (c) => {
		const user = c.get("user");
		const query = c.req.valid("query");
		const scope = query.scope ?? "mine";
		if (!SESSION_SCOPES.has(scope)) throw new UserError("scope must be mine, shared, visible or all");
		if (scope === "all" && !isAdmin(user)) throw new HTTPException(403, { message: "administrators only" });
		const keywords = parseSearchKeywords(query.q);
		const limit = parseSearchLimit(query.limit);
		const rawCursor = query.cursor;
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, SESSION_CURSOR);
		const page = await sessionSearch(db, user, {
			scope: scope as SessionListScope,
			keywords,
			limit,
			...(cursor ? { cursor } : {}),
		});
		return c.json(page, 200);
	});

	/**
	 * The extensions a new session of the caller reaches, before a session exists (doc/design/extensions.md
	 * "Extensions"): the list the created session's `extensions` will show, every entry on. Any signed-in user
	 * gets their own list; the administrator's `/extensions` stays separate.
	 */
	app.openapi(extensionsRoute, async (c) => {
		const extensions = await runtime.availableExtensions(c.get("user").userId);
		return c.json({ extensions }, 200);
	});

	/**
	 * Creates a session and submits its first message in one request: `{ requestId, model, rulePreset,
	 * budgetRemaining?, title?, message, disabledExtensions? }`. A retry with the same request id returns the
	 * session the first attempt made (200) instead of creating another; a new session is 201. A failure to
	 * submit removes the new session again.
	 */
	app.openapi(createRoute, async (c) => {
		const body = c.req.valid("json");
		const requestId = body.requestId.trim();
		if (requestId === "" || requestId.length > 128) {
			throw new UserError("requestId is required and must be at most 128 characters");
		}
		const message = body.message.trim();
		if (message === "") throw new UserError("message is required");
		// Any level may have a remaining budget; null (or no field) is unlimited and never charged.
		const budgetRemaining = body.budgetRemaining === undefined ? undefined : parseQuota(body.budgetRemaining);
		const inputs = body.attachments ?? [];
		const resolved =
			inputs.length === 0
				? undefined
				: await resolveAttachments(db, options.cluster.libraryBackend, c.get("user"), inputs, attachmentLimits());
		const { session, created } = await runtime.createSessionWithMessage(c.get("user"), {
			requestId,
			message,
			model: parseModelRef(body.model),
			rulePreset: parseRulePreset(body.rulePreset ?? "ask"),
			// The session records where its latest user message came from; the creator owns it, so the WebUI.
			// This route is agent: "deny", so an in-process api_request never reaches it: the null branch is
			// defensive only, because only a scheduled run has no source.
			lastUsedFrom: c.get("user").actor === undefined ? "web" : null,
			...(body.title === undefined ? {} : { title: body.title }),
			...(budgetRemaining === undefined ? {} : { budgetRemaining }),
			// Omitted means all available extensions are on, as for sessions created by channels or tokens.
			...(body.disabledExtensions === undefined
				? {}
				: { disabledExtensions: parseDisabledExtensions(body.disabledExtensions) }),
			...(resolved
				? {
						content: attachmentContent(message, resolved.blocks),
						attachments: resolved.attachments,
					}
				: {}),
		});
		return c.json({ session: await decorateOne(c, session) }, created ? 201 : 200);
	});

	app.openapi(getRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id);
		// The state is a cache of the run and its waits; refresh it from durable and the task table before showing it.
		await runtime.refreshState(v.session.id);
		const session = (await runtime.getSession(v.session.id)) ?? v.session;
		const canShare = v.capabilities.manageShares;
		// A subagent inherits its root's share; `decorate` only knows direct shares, so use what `visible` resolved.
		const viewed = await decorateOne(c, session);
		return c.json(
			{
				session: { ...viewed, relationship: v.relationship, capabilities: v.capabilities },
				...(canShare ? { shares: await listSessionShares(db, session.id) } : {}),
			},
			200,
		);
	});

	/**
	 * Marks the tree read for its owner (doc/design/webui.md "Sidebar list"): `POST /api/sessions/:id/read` sets the root's
	 * `owner_read_at` to now and republishes the root, so the owner's other tabs clear the unread dot. `:id` may
	 * be any session of the tree, so opening a subagent marks its whole tree. Only the owner may mark a tree
	 * read. `updated_at` is not touched: marking read must not reorder the list. Answers 204.
	 */
	app.openapi(readRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id, "owner");
		const rootId = await rootSessionIdOf(db, v.session.id);
		if (!rootId) throw new NotFoundError("no such session");
		await db
			.updateTable("sessions")
			.set({ owner_read_at: new Date().toISOString() })
			.where("id", "=", rootId)
			.execute();
		runtime.sessionList.publishSession(rootId);
		return c.body(null, 204);
	});

	/**
	 * The session's direct child sessions (subagents), newest activity first, one keyset page at a time
	 * (doc/design/webui.md "API conventions"). Visibility is `GET /sessions/:id`'s: a share on a session reaches its subagents,
	 * so every child of a visible session is visible and the items need no per-child check. Unlike the root
	 * list, an item carries the child's own state and its `parentSessionId`. The session list stream carries
	 * roots only; a page refetches its children on its session's `snapshot`, on a `tool_execution_update` /
	 * `tool_execution_end` of the `subagent` tool (the update's `details.sessionId` names the new child), and on
	 * its tree root's `upsert` on `/api/sessions/stream`, which every session in the tree republishes.
	 */
	app.openapi(childrenRoute, async (c) => {
		const { id } = c.req.valid("param");
		const query = c.req.valid("query");
		const v = await requireSession(c, id);
		const limit = parseLimit(query.limit);
		const rawCursor = query.cursor;
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, SESSION_CURSOR);
		const page = await cursorRows(
			limit,
			async (limitPlusOne) => (await sessionChildrenQuery(db, v.session.id, cursor)).limit(limitPlusOne).execute(),
			(row) => sessionListCursor(row.updated_at, row.id),
		);
		return c.json(
			{
				items: page.rows.map((row) => sessionChildItem(row, c.get("user").userId, v.shared)),
				nextCursor: page.nextCursor,
			},
			200,
		);
	});

	/**
	 * How many direct child sessions this session has, by their own state, for the compact children bar
	 * (doc/design/webui.md "Subagent bar"). The count must not require every page of the children list, so it is its own
	 * endpoint; visibility is `GET /sessions/:id`'s.
	 */
	app.openapi(childrenSummaryRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id);
		const rows = await db
			.selectFrom("sessions")
			.select(["state"])
			.select((eb) => eb.fn.countAll<string>().as("count"))
			.where("parent_session_id", "=", v.session.id)
			.groupBy("state")
			.execute();
		const states: Record<"idle" | "running" | "awaiting", number> = { idle: 0, running: 0, awaiting: 0 };
		let total = 0;
		for (const row of rows) {
			const count = Number(row.count);
			total += count;
			if (row.state === "idle" || row.state === "running" || row.state === "awaiting") states[row.state] += count;
		}
		return c.json({ total, states }, 200);
	});

	app.openapi(sharesRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id, "manageShares");
		return c.json({ shares: await listSessionShares(db, v.session.id) }, 200);
	});

	app.openapi(addShareRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id, "createShares");
		const body = c.req.valid("json");
		if (!body.granteeId) throw new UserError("granteeId is required");
		// A share to oneself would duplicate the caller's own access (and, for an administrator, turn a
		// read-only relationship into a driveable one).
		if (body.granteeType === "user" && body.granteeId === c.get("user").userId) {
			throw new UserError("a session cannot be shared with yourself");
		}
		const share = await shareSession(db, {
			sessionId: v.session.id,
			granteeType: body.granteeType,
			granteeId: body.granteeId,
			access: body.access,
			createdBy: c.get("user").userId,
		});
		await runtime.sessionList.publishShareAdded(v.session.id, {
			granteeType: body.granteeType,
			granteeId: body.granteeId,
		});
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "session.shared",
			target: { type: "session", id: v.session.id },
			detail: { grantee_type: body.granteeType, grantee_id: body.granteeId, access: body.access },
		});
		return c.json({ share }, 200);
	});

	app.openapi(removeShareRoute, async (c) => {
		const { id, shareId } = c.req.valid("param");
		const v = await requireSession(c, id, "manageShares");
		const share = (await listSessionShares(db, v.session.id)).find((s) => s.id === shareId);
		// Who the share reached, captured before the row goes: losing it may remove the session from their list.
		const audience = share
			? await shareAudienceUserIds(db, { granteeType: share.granteeType, granteeId: share.granteeId })
			: [];
		await unshareSession(db, v.session.id, shareId);
		await runtime.sessionList.publishShareRemoved(v.session.id, audience);
		await streams.revalidate();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "session.unshared",
			target: { type: "session", id: v.session.id },
			detail: {
				share_id: shareId,
				grantee_type: share?.granteeType,
				grantee_id: share?.granteeId,
				access: share?.access,
			},
		});
		return c.json({ ok: true as const }, 200);
	});

	app.openapi(patchRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id, "configure");
		const s = v.session;
		const body = c.req.valid("json");
		const rulePreset = body.rulePreset === undefined ? undefined : parseRulePreset(body.rulePreset);
		const session = await runtime.configure(s.id, {
			...(body.title === undefined ? {} : { title: body.title }),
			...(body.model === undefined ? {} : { model: parseModelRef(body.model) }),
			...(rulePreset ? { rulePreset } : {}),
			...(body.budgetRemaining !== undefined ? { budgetRemaining: parseQuota(body.budgetRemaining) } : {}),
			...(body.disabledExtensions !== undefined
				? { disabledExtensions: parseDisabledExtensions(body.disabledExtensions) }
				: {}),
		});
		if (body.budgetRemaining !== undefined) {
			void c.get("audit").record({
				actor: userActor(c.get("user")),
				action: "session.quota",
				target: { type: "session", id: s.id },
				detail: { budget_remaining: body.budgetRemaining },
			});
		}
		if (rulePreset) {
			void c.get("audit").record({
				actor: userActor(c.get("user")),
				action: "rules.changed",
				target: { type: "session", id: s.id },
				detail: { rule_preset: rulePreset },
			});
			// Waiting tool calls may not need approval any more (doc/design/access-control.md "Approvals").
			await reevaluateAfterRuleChange(db, options.cluster, options.taskGroups, { type: "session", id: s.id });
		}
		return c.json({ session: await decorateOne(c, session) }, 200);
	});

	/** `{ text, requestId }`: requestId makes a retried send land once. The session acts for its owner. */
	app.openapi(messagesRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id, "chat");
		const body = c.req.valid("json");
		const text = body.text.trim();
		const requestId = body.requestId ? body.requestId.slice(0, 200) : undefined;
		if (!text) throw new UserError("text is required");
		if (!requestId) throw new UserError("requestId is required");
		const inputs = body.attachments ?? [];
		if (inputs.length > 0 && v.session.ownerUserId !== c.get("user").userId) {
			throw new HTTPException(403, { message: "only the session owner can attach files" });
		}
		const resolved =
			inputs.length === 0
				? undefined
				: await resolveAttachments(db, options.cluster.libraryBackend, c.get("user"), inputs, attachmentLimits());
		const submissionId = await runtime.submit(v.session.id, c.get("user"), text, requestId, {
			// A shared user's message counts as the WebUI, so notifications never follow their chat. This route
			// is agent: "deny", so an in-process api_request never reaches it: the owner's null branch is
			// defensive only, because only a scheduled run has no source.
			lastUsedFrom: c.get("user").actor === undefined || v.session.ownerUserId !== c.get("user").userId ? "web" : null,
			...(resolved ? { content: attachmentContent(text, resolved.blocks), attachments: resolved.attachments } : {}),
		});
		return c.json({ submissionId }, 202);
	});

	/** `{ instructions? }`: a manual compaction; the summary is made in the background (doc/design/agent-runtime.md "Sessions"). */
	app.openapi(compactRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id, "chat");
		const body = c.req.valid("json");
		const trimmed = body.instructions?.trim() ?? "";
		if (trimmed.length > 2000) throw new UserError("instructions must be at most 2000 characters");
		const instructions = trimmed || undefined;
		const { taskId, outcome } = await runtime.compact(v.session.id, c.get("user"), instructions);
		return c.json({ taskId, outcome }, 202);
	});

	/**
	 * `{ entryId, requestId }`: forks the session at one of its final replies into a new root
	 * (doc/design/agent-runtime.md "Forking"). Only the owner may fork, and a repeated request id returns the
	 * fork the first request made (200) instead of creating another (201).
	 */
	app.openapi(forkRoute, async (c) => {
		const { id } = c.req.valid("param");
		const user = c.get("user");
		const body = c.req.valid("json");
		const requestId = body.requestId.trim();
		if (requestId === "" || requestId.length > 128) {
			throw new UserError("requestId is required and must be at most 128 characters");
		}
		// A retry returns the first fork even when its source has been deleted since, so the idempotency check
		// comes before the source's owner check (the request id is scoped to the caller).
		const existing = await runtime.findSessionByCreateRequestId(user.userId, requestId);
		if (existing) return c.json({ session: await decorateOne(c, existing) }, 200);
		const v = await requireSession(c, id, "owner");
		const { session, created } = await runtime.forkSession(user, v.session.id, {
			entryId: body.entryId,
			requestId,
		});
		return c.json({ session: await decorateOne(c, session) }, created ? 201 : 200);
	});

	/**
	 * `{ decision: "approve" | "deny", tokens?, reason? }`: the owner's answer when a root's quota is used up
	 * (doc/design/agent-runtime.md "Quota and token accounting"). Only the owner decides, like the approvals on the approvals page.
	 */
	app.openapi(quotaRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id, "owner");
		const user = c.get("user");
		const body = c.req.valid("json");
		const reason =
			typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 1000) : undefined;
		let tokens: number | undefined;
		if (body.decision === "approve") {
			if (typeof body.tokens !== "number" || !Number.isInteger(body.tokens) || body.tokens <= 0) {
				throw new UserError("tokens must be a positive integer");
			}
			tokens = body.tokens;
		}
		// A scheduled run ends failed when its owner denies the root quota (doc/design/scheduling.md "Triggering and submission").
		const quotaReason = reason ?? (body.decision === "deny" ? "the owner stopped the run" : undefined);
		const noteQuotaDenied = body.decision === "deny" && quotaReason !== undefined;
		// The note goes first: deciding wakes the wait, and a run that settles before the note is read would be
		// recorded as succeeded. A decision that throws (no such wait) removes the note again, so a later normal
		// finish is not marked failed.
		if (noteQuotaDenied) {
			await options.scheduler?.noteQuotaDenied(v.session.id, `quota denied: ${quotaReason}`);
		}
		let sessions: string[];
		try {
			sessions = await runtime.decideRootQuota(v.session.id, body.decision, tokens);
		} catch (err) {
			if (noteQuotaDenied) options.scheduler?.clearQuotaDenied(v.session.id);
			throw err;
		}
		void c.get("audit").record({
			actor: userActor(user),
			action: body.decision === "deny" ? "quota.denied" : "quota.granted",
			target: { type: "session", id: v.session.id },
			detail: { level: v.session.id, sessions, ...(reason ? { reason } : {}), ...(tokens ? { tokens } : {}) },
		});
		return c.json({ ok: true as const, sessions }, 200);
	});

	app.openapi(abortRoute, async (c) => {
		const { id } = c.req.valid("param");
		const v = await requireSession(c, id, "chat");
		await runtime.abort(v.session.id, c.get("user"), { source: "web" });
		return c.json({ ok: true as const }, 200);
	});

	/**
	 * Older history for a session, one page at a time (doc/design/webui.md "Session event stream and history"): the shown entries
	 * immediately before `before`, oldest first, plus the cursor for the page after this one. The snapshot's
	 * `historyCursor` is the first `before`; a later page's `historyCursor` is the next. Visibility is the
	 * same as for `/events`.
	 */
	app.openapi(entriesRoute, async (c) => {
		const { id } = c.req.valid("param");
		const query = c.req.valid("query");
		const v = await requireSession(c, id);
		const limit = parseLimit(query.limit, DEFAULT_HISTORY);
		const before = query.before;
		const beforeId = before === undefined ? undefined : Number(decodeCursor(before, HISTORY_CURSOR).id);
		const page = await runtime.entriesPage(v.session.id, beforeId, limit);
		const entries: SessionEntry[] = page.entries;
		return c.json({ entries, historyCursor: page.historyCursor }, 200);
	});

	return app;
}

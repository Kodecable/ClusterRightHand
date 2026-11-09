import type { SessionView as ApiSessionView } from "@crh/api";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { parseModelRef } from "../agent/models.ts";
import { parseQuota } from "../agent/quota.ts";
import type { AgentRuntime, SessionView } from "../agent/runtime.ts";
import { rootSessionIdOf } from "../agent/session-chain.ts";
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
import {
	capabilitiesFor,
	listSessionShares,
	type SessionPermissions,
	sessionCapabilities,
	sharedSessionAccess,
	shareSession,
	unshareSession,
} from "../agent/sharing.ts";
import { userActor } from "../audit/audit.ts";
import { isAdmin, type SessionUser } from "../auth/sessions.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import { parseRulePreset } from "../policy/store.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Db } from "../storage/db.ts";
import { usernamesById } from "../users/service.ts";
import { type CursorSpec, cursorRows, decodeCursor, parseLimit } from "../util/cursor.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import type { SessionStreams } from "./session-events-routes.ts";

export interface SessionRoutesOptions {
	runtime: AgentRuntime;
	cluster: Cluster;
	taskGroups: TaskGroups;
	/** The open event streams: removing a share may end some of them. */
	streams: SessionStreams;
	/** Tells the scheduler when a scheduled run's root quota was denied, so the run ends failed (doc/scheduling.md). */
	scheduler?: Scheduler;
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
/** History pages default to 100 entries (doc/webui.md#会话事件流和历史). */
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
		if (runtime.closing) return jsonError(c, 503, "server is shutting down");
		await next();
	};
}

/**
 * Sessions (chat with the agent); doc/agent-runtime.md. Expects requireUser and refuseWhenClosing; the
 * event streams are in session-events-routes.ts, registered first.
 */
export function sessionRoutes(db: Db, options: SessionRoutesOptions) {
	const { runtime, streams } = options;
	const app = new Hono<AppEnv>();

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
	 * The session and the caller's capabilities, or the response the route returns instead: the visibility
	 * 404, then the capability's 403. `"owner"` is the owner-only check for the paths no capability names
	 * exactly (the root quota decision), answered "the owner only" like `configure`.
	 */
	const requireSession = async (
		c: Context<AppEnv>,
		id: string,
		capability?: keyof typeof CAPABILITY_DENIED | "owner",
	): Promise<VisibleSession | Response> => {
		const v = await visible(c, id);
		if (!v) return jsonError(c, 404, "no such session");
		if (capability === undefined) return v;
		if (capability === "owner") {
			return v.session.ownerUserId === c.get("user").userId ? v : jsonError(c, 403, "the owner only");
		}
		return v.capabilities[capability] ? v : jsonError(c, 403, CAPABILITY_DENIED[capability]);
	};
	const decorate = async (c: Context<AppEnv>, views: SessionView[]): Promise<ApiSessionView[]> => {
		const user = c.get("user");
		const names = await usernamesById(db, [...new Set(views.map((v) => v.ownerUserId))]);
		const shared = await sharedSessionAccess(db, user.userId);
		return views.map((v) => {
			const isOwner = v.ownerUserId === user.userId;
			const admin = isAdmin(user);
			const share = shared.get(v.id);
			return {
				...v,
				relationship: isOwner ? ("owner" as const) : admin ? ("admin" as const) : ("shared" as const),
				capabilities: capabilitiesFor(isOwner, admin, share),
				ownerUsername: names.get(v.ownerUserId) ?? null,
			};
		});
	};

	/**
	 * Root sessions as `SessionListItem`, newest activity first, one keyset page at a time
	 * (doc/webui.md#会话列表). `scope=all` is administrators only; `shared` means a share reaches the caller,
	 * not ownership; `visible` is the owner-and-shared union the WebUI lists. Default `mine`. `GET /sessions/:id`
	 * stays the full SessionView.
	 */
	app.get("/sessions", async (c) => {
		const user = c.get("user");
		const scope = c.req.query("scope") ?? "mine";
		if (!SESSION_SCOPES.has(scope)) return jsonError(c, 400, "scope must be mine, shared, visible or all");
		if (scope === "all" && !isAdmin(user)) return jsonError(c, 403, "administrators only");
		const limit = parseLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, SESSION_CURSOR);
		const q = c.req.query("q");
		const scheduleId = c.req.query("scheduleId");
		const ownerId = c.req.query("ownerId");
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
		return c.json({
			// The query's `shared` EXISTS is 0/1 on SQLite and a boolean on PostgreSQL.
			items: page.rows.map((row) => sessionListItem(row, user.userId, Boolean(row.shared))),
			nextCursor: page.nextCursor,
		});
	});

	/**
	 * Root sessions matching every whitespace-separated keyword of `q` in their title or message text, newest
	 * activity first, one keyset page at a time (doc/webui.md#会话内容搜索). Titles are searched on both backends;
	 * message content only on PostgreSQL, where the pg-durable adapter's generated `search_text` column exists.
	 * So SQLite answers `contentSearch: false` and never fills `hits` or `hitCount`. The scope, visibility and
	 * cursor are the session list's. Registered before `/sessions/:id`, which would otherwise read "search" as an id.
	 */
	app.get("/sessions/search", async (c) => {
		const user = c.get("user");
		const scope = c.req.query("scope") ?? "mine";
		if (!SESSION_SCOPES.has(scope)) return jsonError(c, 400, "scope must be mine, shared, visible or all");
		if (scope === "all" && !isAdmin(user)) return jsonError(c, 403, "administrators only");
		const keywords = parseSearchKeywords(c.req.query("q"));
		const limit = parseSearchLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, SESSION_CURSOR);
		const page = await sessionSearch(db, user, {
			scope: scope as SessionListScope,
			keywords,
			limit,
			...(cursor ? { cursor } : {}),
		});
		return c.json(page);
	});

	/**
	 * Creates a session and submits its first message in one request (D117): `{ requestId, model, rulePreset,
	 * budgetRemaining?, title?, message }`. A retry with the same request id returns the session the first
	 * attempt made (200) instead of creating another; a new session is 201. A failure to submit removes the
	 * new session again.
	 */
	app.post("/sessions", async (c) => {
		const body = (await readJsonObject(c)) ?? {};
		const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
		if (requestId === "" || requestId.length > 128) {
			return jsonError(c, 400, "requestId is required and must be at most 128 characters");
		}
		const message = typeof body.message === "string" ? body.message.trim() : "";
		if (message === "") return jsonError(c, 400, "message is required");
		// Any level may have a remaining budget; null (or no field) is unlimited and never charged (D92, D101).
		const budgetRemaining = body.budgetRemaining === undefined ? undefined : parseQuota(body.budgetRemaining);
		const { session, created } = await runtime.createSessionWithMessage(c.get("user"), {
			requestId,
			message,
			model: parseModelRef(body.model),
			rulePreset: parseRulePreset(body.rulePreset ?? "ask"),
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(budgetRemaining === undefined ? {} : { budgetRemaining }),
		});
		return c.json({ session: (await decorate(c, [session]))[0] }, created ? 201 : 200);
	});

	app.get("/sessions/:id", async (c) => {
		const v = await requireSession(c, c.req.param("id"));
		if (v instanceof Response) return v;
		// The state is a cache of the run and its waits; refresh it from durable and the task table before showing it.
		await runtime.refreshState(v.session.id);
		const session = (await runtime.getSession(v.session.id)) ?? v.session;
		const canShare = v.capabilities.manageShares;
		// A subagent inherits its root's share; `decorate` only knows direct shares, so use what `visible` resolved.
		const viewed = (await decorate(c, [session]))[0];
		return c.json({
			session: { ...viewed, relationship: v.relationship, capabilities: v.capabilities },
			...(canShare ? { shares: await listSessionShares(db, session.id) } : {}),
		});
	});

	/**
	 * Marks the tree read for its owner (doc/webui.md#侧边列表): `POST /api/sessions/:id/read` sets the root's
	 * `owner_read_at` to now and republishes the root, so the owner's other tabs clear the unread dot. `:id` may
	 * be any session of the tree, so opening a subagent marks its whole tree. Only the owner may mark a tree
	 * read. `updated_at` is not touched: marking read must not reorder the list. Answers 204.
	 */
	app.post("/sessions/:id/read", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "owner");
		if (v instanceof Response) return v;
		const rootId = (await rootSessionIdOf(db, v.session.id)) ?? v.session.id;
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
	 * (doc/webui.md#api-约定). Visibility is `GET /sessions/:id`'s: a share on a session reaches its subagents,
	 * so every child of a visible session is visible and the items need no per-child check. Unlike the root
	 * list, an item carries the child's own state and its `parentSessionId`. The session list stream carries
	 * roots only; a page refetches its children on its session's `snapshot`, on a `tool_execution_update` /
	 * `tool_execution_end` of the `subagent` tool (the update's `details.sessionId` names the new child), and on
	 * its tree root's `upsert` on `/api/sessions/stream`, which every session in the tree republishes.
	 */
	app.get("/sessions/:id/children", async (c) => {
		const v = await requireSession(c, c.req.param("id"));
		if (v instanceof Response) return v;
		const limit = parseLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, SESSION_CURSOR);
		const page = await cursorRows(
			limit,
			async (limitPlusOne) => (await sessionChildrenQuery(db, v.session.id, cursor)).limit(limitPlusOne).execute(),
			(row) => sessionListCursor(row.updated_at, row.id),
		);
		return c.json({
			items: page.rows.map((row) => sessionChildItem(row, c.get("user").userId, v.shared)),
			nextCursor: page.nextCursor,
		});
	});

	/**
	 * How many direct child sessions this session has, by their own state, for the compact children bar
	 * (doc/webui.md#子会话栏). The count must not require every page of the children list, so it is its own
	 * endpoint; visibility is `GET /sessions/:id`'s.
	 */
	app.get("/sessions/:id/children/summary", async (c) => {
		const v = await requireSession(c, c.req.param("id"));
		if (v instanceof Response) return v;
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
		return c.json({ total, states });
	});

	app.get("/sessions/:id/shares", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "manageShares");
		if (v instanceof Response) return v;
		return c.json({ shares: await listSessionShares(db, v.session.id) });
	});

	app.put("/sessions/:id/shares", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "createShares");
		if (v instanceof Response) return v;
		const body = await readJsonObject(c);
		if (body?.granteeType !== "user" && body?.granteeType !== "user_group")
			return jsonError(c, 400, "granteeType must be user or user_group");
		if (typeof body?.granteeId !== "string" || !body.granteeId) return jsonError(c, 400, "granteeId is required");
		if (body?.access !== "view" && body?.access !== "chat") return jsonError(c, 400, "access must be view or chat");
		// A share to oneself would duplicate the caller's own access (and, for an administrator, turn a
		// read-only relationship into a driveable one).
		if (body.granteeType === "user" && body.granteeId === c.get("user").userId) {
			return jsonError(c, 400, "a session cannot be shared with yourself");
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
		return c.json({ share });
	});

	app.delete("/sessions/:id/shares/:shareId", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "manageShares");
		if (v instanceof Response) return v;
		const share = (await listSessionShares(db, v.session.id)).find((s) => s.id === c.req.param("shareId"));
		// Who the share reached, captured before the row goes: losing it may remove the session from their list.
		const audience = share
			? await shareAudienceUserIds(db, { granteeType: share.granteeType, granteeId: share.granteeId })
			: [];
		await unshareSession(db, v.session.id, c.req.param("shareId"));
		await runtime.sessionList.publishShareRemoved(v.session.id, audience);
		await streams.revalidate();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "session.unshared",
			target: { type: "session", id: v.session.id },
			detail: {
				share_id: c.req.param("shareId"),
				grantee_type: share?.granteeType,
				grantee_id: share?.granteeId,
				access: share?.access,
			},
		});
		return c.json({ ok: true });
	});

	app.patch("/sessions/:id", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "configure");
		if (v instanceof Response) return v;
		const s = v.session;
		const body = (await readJsonObject(c)) ?? {};
		const rulePreset = body.rulePreset === undefined ? undefined : parseRulePreset(body.rulePreset);
		const session = await runtime.configure(s.id, {
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(body.model !== undefined ? { model: parseModelRef(body.model) } : {}),
			...(rulePreset ? { rulePreset } : {}),
			...(body.budgetRemaining !== undefined ? { budgetRemaining: parseQuota(body.budgetRemaining) } : {}),
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
			// Waiting tool calls may not need approval any more (doc/access-control.md#审批).
			const ref = { type: "session" as const, id: s.id };
			await options.cluster.reevaluate(ref);
			await options.taskGroups.reevaluate(ref);
		}
		return c.json({ session: (await decorate(c, [session]))[0] });
	});

	/** `{ text, requestId }`: requestId makes a retried send land once. The session acts for its owner. */
	app.post("/sessions/:id/messages", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "chat");
		if (v instanceof Response) return v;
		const body = await readJsonObject(c);
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		const requestId = typeof body?.requestId === "string" && body.requestId ? body.requestId.slice(0, 200) : undefined;
		if (!text) return jsonError(c, 400, "text is required");
		if (!requestId) return jsonError(c, 400, "requestId is required");
		const submissionId = await runtime.submit(v.session.id, c.get("user"), text, requestId);
		return c.json({ submissionId }, 202);
	});

	/** `{ instructions? }`: a manual compaction; the summary is made in the background (doc/agent-runtime.md#会话). */
	app.post("/sessions/:id/compact", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "chat");
		if (v instanceof Response) return v;
		const body = await readJsonObject(c);
		const trimmed = typeof body?.instructions === "string" ? body.instructions.trim() : "";
		if (trimmed.length > 2000) return jsonError(c, 400, "instructions must be at most 2000 characters");
		const instructions = trimmed || undefined;
		const { taskId, outcome } = await runtime.compact(v.session.id, c.get("user"), instructions);
		return c.json({ taskId, outcome }, 202);
	});

	/**
	 * `{ decision: "approve" | "deny", tokens?, reason? }`: the owner's answer when a root's quota is used up
	 * (doc/agent-runtime.md#配额). Only the owner decides, like the approvals on the approvals page.
	 */
	app.post("/sessions/:id/quota", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "owner");
		if (v instanceof Response) return v;
		const user = c.get("user");
		const body = await readJsonObject(c);
		if (body?.decision !== "approve" && body?.decision !== "deny") {
			return jsonError(c, 400, 'decision must be "approve" or "deny"');
		}
		const reason =
			typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 1000) : undefined;
		let tokens: number | undefined;
		if (body.decision === "approve") {
			if (typeof body.tokens !== "number" || !Number.isInteger(body.tokens) || body.tokens <= 0) {
				return jsonError(c, 400, "tokens must be a positive integer");
			}
			tokens = body.tokens;
		}
		// A scheduled run ends failed when its owner denies the root quota (doc/scheduling.md#调度).
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
		return c.json({ ok: true, sessions });
	});

	app.post("/sessions/:id/abort", async (c) => {
		const v = await requireSession(c, c.req.param("id"), "chat");
		if (v instanceof Response) return v;
		await runtime.abort(v.session.id, c.get("user"));
		return c.json({ ok: true });
	});

	/**
	 * Older history for a session, one page at a time (doc/webui.md#会话事件流和历史): the shown entries
	 * immediately before `before`, oldest first, plus the cursor for the page after this one. The snapshot's
	 * `historyCursor` is the first `before`; a later page's `historyCursor` is the next. Visibility is the
	 * same as for `/events`.
	 */
	app.get("/sessions/:id/entries", async (c) => {
		const v = await requireSession(c, c.req.param("id"));
		if (v instanceof Response) return v;
		const limit = parseLimit(c.req.query("limit"), DEFAULT_HISTORY);
		const before = c.req.query("before");
		const beforeId = before === undefined ? undefined : Number(decodeCursor(before, HISTORY_CURSOR).id);
		const page = await runtime.entriesPage(v.session.id, beforeId, limit);
		return c.json({ entries: page.entries, historyCursor: page.historyCursor });
	});

	return app;
}

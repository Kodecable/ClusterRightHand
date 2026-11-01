import { type Context, Hono, type Next } from "hono";
import { streamSSE } from "hono/streaming";
import {
	builtinProviderIds,
	type CompatibleModel,
	deleteModelProvider,
	listModelProviders,
	type ModelConfig,
	parseModelRef,
	saveModelProvider,
} from "../agent/models.ts";
import { parseQuota } from "../agent/quota.ts";
import { getReviewModel, setReviewModel } from "../agent/review.ts";
import type { AgentRuntime, SessionView } from "../agent/runtime.ts";
import {
	type SessionListScope,
	type SessionListSubscriber,
	sessionChildItem,
	sessionChildrenQuery,
	sessionListCursor,
	sessionListItem,
	sessionListQuery,
	shareAudienceUserIds,
} from "../agent/session-list.ts";
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
import type { SessionUser } from "../auth/sessions.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { MasterKey } from "../keys/master-key.ts";
import { parsePreset } from "../policy/store.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";
import { type CursorSpec, cursorRows, decodeCursor, parseLimit } from "./cursor.ts";
import type { RequestDrain } from "./drain.ts";

export interface SessionRoutesOptions {
	runtime: AgentRuntime;
	models: ModelConfig;
	masterKey: MasterKey;
	cluster: Cluster;
	groups: TaskGroups;
	/** Shutdown bookkeeping: its abort ends the event streams, and each stream keeps shutdown waiting. */
	drain?: RequestDrain;
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
const SCOPES: ReadonlySet<string> = new Set(["mine", "shared", "all"]);

/** `stream.sleep`, but wakes up when the stream ends, so shutdown need not wait out a ping interval. */
function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Sessions (chat with the agent) and model configuration; doc/agent-runtime.md. Expects requireUser. */
export function sessionRoutes(db: Db, options: SessionRoutesOptions) {
	const { runtime, models } = options;
	type LiveStream = { user: SessionUser; sessionId: string; abort: () => void };
	const streams = new Set<LiveStream>();
	const drain = options.drain;
	/** Ends a stream the way a client disconnect does: its abort controller fires and the loop below runs out. */
	const endStream = (stream: LiveStream) => {
		streams.delete(stream);
		stream.abort();
	};
	/**
	 * The viewer as the account is now. A stream opened before a kind change or a disable would otherwise keep
	 * the capabilities it was opened with.
	 */
	const currentViewer = async (user: SessionUser): Promise<SessionUser | undefined> => {
		const row = await db
			.selectFrom("users")
			.select(["id", "username", "kind", "status"])
			.where("id", "=", user.userId)
			.executeTakeFirst();
		if (row?.status !== "active") return undefined;
		return { ...user, username: row.username, kind: row.kind };
	};
	/** A share change or an account change can remove access to a session or to a root whose subagents it watches. */
	const revalidateStreams = async () => {
		for (const stream of [...streams]) {
			const viewer = await currentViewer(stream.user);
			if (viewer && (await sessionCapabilities(db, viewer, stream.sessionId))) continue;
			endStream(stream);
		}
	};
	// A user's status/kind, a group membership or a share change reaches the streams through the session list
	// hub, which the user routes also hold: this is the same path for every access change.
	const unsubscribeVisibility = runtime.sessionList.onVisibilityChanged(revalidateStreams);
	// Shutdown ends every stream, so no request outlives the database it may still need.
	drain?.shutdown.signal.addEventListener(
		"abort",
		() => {
			unsubscribeVisibility();
			for (const stream of [...streams]) endStream(stream);
			options.runtime.sessionList.close();
		},
		{ once: true },
	);
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		// Shutdown closes the runtime under requests that were already in flight (main.ts): answer with the
		// shutdown, not the closed Harness's exception.
		if (runtime.closing) return jsonError(c, 503, "server is shutting down");
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError) return jsonError(c, 400, err.message);
		throw err;
	});

	const admin = (c: Context<AppEnv>) => c.get("user").kind === "admin";

	// Shutdown closes the runtime before the drain is idle (main.ts): a session request still in flight must
	// fail with a normal error instead of reaching the closed Harness.
	const refuseWhenClosing = async (c: Context<AppEnv>, next: Next) => {
		if (runtime.closing) return jsonError(c, 503, "server is shutting down");
		await next();
	};
	app.use("/sessions", refuseWhenClosing);
	app.use("/sessions/*", refuseWhenClosing);

	// ---- models ----

	app.get("/models", (c) => c.json({ models: models.available() }));

	app.get("/model-providers", async (c) => {
		if (!admin(c)) return jsonError(c, 403, "administrators only");
		return c.json({ providers: await listModelProviders(db), builtin: builtinProviderIds() });
	});

	app.put("/model-providers/:providerId", async (c) => {
		if (!admin(c)) return jsonError(c, 403, "administrators only");
		const body = await readJsonObject(c);
		if (!body) return jsonError(c, 400, "expected a JSON object");
		const provider = await saveModelProvider(db, options.masterKey, {
			providerId: c.req.param("providerId"),
			kind: body.kind as "builtin" | "openai-compatible",
			...(typeof body.name === "string" ? { name: body.name } : {}),
			...(body.baseUrl === null || typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl as string | null } : {}),
			...(body.apiKey === null || typeof body.apiKey === "string" ? { apiKey: body.apiKey as string | null } : {}),
			...(Array.isArray(body.models) ? { models: body.models as CompatibleModel[] } : {}),
			...(body.headers === null || (typeof body.headers === "object" && !Array.isArray(body.headers))
				? { headers: body.headers as Record<string, string> | null }
				: {}),
			...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
		});
		await models.reload();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "model_provider.saved",
			target: { type: "model_provider", id: provider.providerId },
			detail: {
				kind: provider.kind,
				base_url: provider.baseUrl,
				api_key_set: provider.hasApiKey,
				enabled: provider.enabled,
			},
		});
		return c.json({ provider });
	});

	app.delete("/model-providers/:providerId", async (c) => {
		if (!admin(c)) return jsonError(c, 403, "administrators only");
		await deleteModelProvider(db, c.req.param("providerId"));
		await models.reload();
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "model_provider.deleted",
			target: { type: "model_provider", id: c.req.param("providerId") },
		});
		return c.json({ ok: true });
	});

	app.get("/settings/review-model", async (c) => c.json({ model: await getReviewModel(db) }));

	/** `{ model: ModelRef | null }`: the model Auto Review uses; null: each session's own model (tokens: none). */
	app.put("/settings/review-model", async (c) => {
		if (!admin(c)) return jsonError(c, 403, "administrators only");
		const body = await readJsonObject(c);
		const model = body?.model === null ? null : parseModelRef(body?.model);
		if (model) models.assertAvailable(model);
		await setReviewModel(db, model);
		void c.get("audit").record({
			actor: userActor(c.get("user")),
			action: "settings.review_model",
			target: { type: "settings", id: "review_model" },
			detail: { model },
		});
		return c.json({ model });
	});

	// ---- sessions: the owner, users it is shared with (view / chat), and administrators (view unless shared chat) ----

	type Visible = { session: SessionView } & SessionPermissions;

	/** The session and its capabilities for the caller; undefined when they cannot see it. */
	const visible = async (c: Context<AppEnv>, id: string): Promise<Visible | undefined> => {
		const info = await sessionCapabilities(db, c.get("user"), id);
		if (!info) return undefined;
		const session = await runtime.getSession(id);
		return session ? { session, ...info } : undefined;
	};
	const usernames = async (ids: string[]): Promise<Map<string, string>> =>
		new Map(
			ids.length === 0
				? []
				: (await db.selectFrom("users").select(["id", "username"]).where("id", "in", ids).execute()).map((u) => [
						u.id,
						u.username,
					]),
		);
	const decorate = async (c: Context<AppEnv>, views: SessionView[]) => {
		const user = c.get("user");
		const names = await usernames([...new Set(views.map((v) => v.ownerUserId))]);
		const shared = await sharedSessionAccess(db, user.userId);
		return views.map((v) => {
			const isOwner = v.ownerUserId === user.userId;
			const isAdmin = user.kind === "admin";
			const share = shared.get(v.id);
			return {
				...v,
				relationship: isOwner ? ("owner" as const) : isAdmin ? ("admin" as const) : ("shared" as const),
				capabilities: capabilitiesFor(isOwner, isAdmin, share),
				ownerUsername: names.get(v.ownerUserId) ?? null,
			};
		});
	};

	/**
	 * Root sessions as `SessionListItem`, newest activity first, one keyset page at a time
	 * (doc/webui.md#会话列表). `scope=all` is administrators only; `shared` means a share reaches the caller,
	 * not ownership. `GET /sessions/:id` stays the full SessionView.
	 */
	app.get("/sessions", async (c) => {
		const user = c.get("user");
		const scope = c.req.query("scope") ?? "mine";
		if (!SCOPES.has(scope)) return jsonError(c, 400, "scope must be mine, shared or all");
		if (scope === "all" && user.kind !== "admin") return jsonError(c, 403, "administrators only");
		const limit = parseLimit(c.req.query("limit"));
		const rawCursor = c.req.query("cursor");
		const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor, SESSION_CURSOR);
		const q = c.req.query("q");
		const scheduleId = c.req.query("scheduleId");
		const page = await cursorRows(
			limit,
			async (limitPlusOne) =>
				(
					await sessionListQuery(db, user, {
						scope: scope as SessionListScope,
						...(q ? { q } : {}),
						...(scheduleId === undefined ? {} : { scheduleId }),
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
	 * Session list changes as server-sent events (doc/webui.md#会话列表): `upsert` carries the item as this
	 * subscriber sees it, `remove` says the session is gone (deleted, no longer shared, archived), and `ping`
	 * keeps the connection alive. No initial snapshot: the client fetches page one and reconnects after errors.
	 */
	app.get("/sessions/stream", (c) =>
		streamSSE(c, async (stream) => {
			const abort = new AbortController();
			let queue: Promise<unknown> = Promise.resolve();
			const subscriber: SessionListSubscriber = {
				user: c.get("user"),
				send: (event, data) => {
					queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
					void queue.catch(() => stream.abort());
				},
				close: () => stream.abort(),
			};
			const unsubscribe = runtime.sessionList.subscribe(subscriber);
			stream.onAbort(() => {
				unsubscribe();
				abort.abort();
			});
			// As with a session's event stream, the connection keeps shutdown waiting until it ends.
			const release = drain?.hold();
			try {
				if (drain?.shutdown.signal.aborted) stream.abort();
				if (abort.signal.aborted) return;
				while (!abort.signal.aborted) {
					await sleepFor(15_000, abort.signal);
					if (!abort.signal.aborted) await stream.writeSSE({ event: "ping", data: "" });
				}
			} finally {
				unsubscribe();
				release?.();
			}
		}),
	);

	app.post("/sessions", async (c) => {
		const body = (await readJsonObject(c)) ?? {};
		// Any level may have a quota; null (or no field) is unlimited and never charged (D92).
		const quota = body.quota === undefined ? undefined : parseQuota(body.quota);
		const session = await runtime.createSession(c.get("user"), {
			model: parseModelRef(body.model),
			preset: parsePreset(body.preset ?? "ask"),
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(quota === undefined ? {} : { quota }),
		});
		return c.json({ session: (await decorate(c, [session]))[0] }, 201);
	});

	app.get("/sessions/:id", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
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
	 * The session's direct child sessions (subagents), newest activity first, one keyset page at a time
	 * (doc/webui.md#api-约定). Visibility is `GET /sessions/:id`'s: a share on a session reaches its subagents,
	 * so every child of a visible session is visible and the items need no per-child check. Unlike the root
	 * list, an item carries the child's own state and its `parentSessionId`. The session list stream carries
	 * roots only; a page refetches its children on its session's `snapshot`, on a `tool_execution_update` /
	 * `tool_execution_end` of the `subagent` tool (the update's `details.sessionId` names the new child), and on
	 * its tree root's `upsert` on `/api/sessions/stream`, which every session in the tree republishes.
	 */
	app.get("/sessions/:id/children", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
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

	app.get("/sessions/:id/shares", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (!v.capabilities.manageShares) return jsonError(c, 403, "the owner only");
		return c.json({ shares: await listSessionShares(db, v.session.id) });
	});

	app.put("/sessions/:id/shares", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (!v.capabilities.manageShares) return jsonError(c, 403, "the owner only");
		const body = await readJsonObject(c);
		if (body?.granteeType !== "user" && body?.granteeType !== "user_group")
			return jsonError(c, 400, "granteeType must be user or user_group");
		if (typeof body?.granteeId !== "string" || !body.granteeId) return jsonError(c, 400, "granteeId is required");
		if (body?.access !== "view" && body?.access !== "chat") return jsonError(c, 400, "access must be view or chat");
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
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (!v.capabilities.manageShares) return jsonError(c, 403, "the owner only");
		const share = (await listSessionShares(db, v.session.id)).find((s) => s.id === c.req.param("shareId"));
		// Who the share reached, captured before the row goes: losing it may remove the session from their list.
		const audience = share
			? await shareAudienceUserIds(db, { granteeType: share.granteeType, granteeId: share.granteeId })
			: [];
		await unshareSession(db, v.session.id, c.req.param("shareId"));
		await runtime.sessionList.publishShareRemoved(v.session.id, audience);
		await revalidateStreams();
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
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (!v.capabilities.configure) return jsonError(c, 403, "the owner only");
		const s = v.session;
		const body = (await readJsonObject(c)) ?? {};
		const preset = body.preset === undefined ? undefined : parsePreset(body.preset);
		const session = await runtime.configure(s.id, {
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(body.model !== undefined ? { model: parseModelRef(body.model) } : {}),
			...(preset ? { preset } : {}),
			...(body.quota !== undefined ? { quota: parseQuota(body.quota) } : {}),
		});
		if (body.quota !== undefined) {
			void c.get("audit").record({
				actor: userActor(c.get("user")),
				action: "session.quota",
				target: { type: "session", id: s.id },
				detail: { quota: body.quota },
			});
		}
		if (preset) {
			void c.get("audit").record({
				actor: userActor(c.get("user")),
				action: "rules.changed",
				target: { type: "session", id: s.id },
				detail: { preset },
			});
			// Waiting tool calls may not need approval any more (doc/access-control.md#审批).
			const ref = { type: "session" as const, id: s.id };
			await options.cluster.reevaluate(ref);
			await options.groups.reevaluate(ref);
		}
		return c.json({ session: (await decorate(c, [session]))[0] });
	});

	/** `{ text, requestId }`: requestId makes a retried send land once. The session acts for its owner. */
	app.post("/sessions/:id/messages", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (!v.capabilities.chat) return jsonError(c, 403, "chat access is required");
		const body = await readJsonObject(c);
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		const requestId = typeof body?.requestId === "string" && body.requestId ? body.requestId.slice(0, 200) : undefined;
		if (!text) return jsonError(c, 400, "text is required");
		if (!requestId) return jsonError(c, 400, "requestId is required");
		const submissionId = await runtime.submit(v.session.id, c.get("user"), text, requestId);
		return c.json({ submissionId }, 202);
	});

	/**
	 * `{ decision: "approve" | "deny", tokens?, reason? }`: the owner's answer when a root's quota is used up
	 * (doc/agent-runtime.md#配额). Only the owner decides, like the approvals on the approvals page.
	 */
	app.post("/sessions/:id/quota", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		const user = c.get("user");
		if (v.session.ownerUserId !== user.userId) return jsonError(c, 403, "the owner only");
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
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (!v.capabilities.chat) return jsonError(c, 403, "chat access is required");
		await runtime.abort(v.session.id, c.get("user"));
		return c.json({ ok: true });
	});

	/** Server-sent events: `snapshot` first, then `events` batches as the session changes. */
	app.get("/sessions/:id/events", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		return streamSSE(c, async (stream) => {
			const abort = new AbortController();
			const live: LiveStream = { user: c.get("user"), sessionId: v.session.id, abort: () => stream.abort() };
			stream.onAbort(() => {
				streams.delete(live);
				abort.abort();
			});
			streams.add(live);
			// The stream outlives its response, so it keeps shutdown waiting until this callback returns.
			const release = drain?.hold();
			try {
				// Shutdown may have begun between authentication and the stream opening: end it now.
				if (drain?.shutdown.signal.aborted) stream.abort();
				if (abort.signal.aborted) return;
				let queue = Promise.resolve();
				const stop = await runtime.watch(
					v.session.id,
					(events) => {
						queue = queue.then(() => stream.writeSSE({ event: "events", data: JSON.stringify(events) }));
						return queue;
					},
					abort.signal,
				);
				// Keep the stream (and proxies) alive while the session is quiet.
				while (!abort.signal.aborted) {
					await sleepFor(15_000, abort.signal);
					if (!abort.signal.aborted) await stream.writeSSE({ event: "ping", data: "" });
				}
				await stop();
			} finally {
				release?.();
			}
		});
	});

	/**
	 * Older history for a session, one page at a time (doc/webui.md#会话事件流和历史): the shown entries
	 * immediately before `before`, oldest first, plus the cursor for the page after this one. The snapshot's
	 * `historyCursor` is the first `before`; a later page's `historyCursor` is the next. Visibility is the
	 * same as for `/events`.
	 */
	app.get("/sessions/:id/entries", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		const limit = parseLimit(c.req.query("limit"), DEFAULT_HISTORY);
		const before = c.req.query("before");
		const beforeId = before === undefined ? undefined : Number(decodeCursor(before, HISTORY_CURSOR).id);
		const page = await runtime.entriesPage(v.session.id, beforeId, limit);
		return c.json({ entries: page.entries, historyCursor: page.historyCursor });
	});

	return app;
}

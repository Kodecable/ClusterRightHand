import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
	builtinProviderIds,
	type CompatibleModel,
	deleteModelProvider,
	listModelProviders,
	type ModelConfig,
	type ModelRef,
	saveModelProvider,
} from "../agent/models.ts";
import { parseQuota } from "../agent/quota.ts";
import { getReviewModel, setReviewModel } from "../agent/review.ts";
import type { AgentRuntime, SessionView } from "../agent/runtime.ts";
import {
	listSessionShares,
	type SessionAccess,
	type SessionShareAccess,
	sessionAccess,
	sharedSessionAccess,
	shareSession,
	unshareSession,
} from "../agent/sharing.ts";
import { userActor } from "../audit/audit.ts";
import type { Cluster } from "../cluster/cluster.ts";
import type { TaskGroups } from "../cluster/task-groups.ts";
import type { MasterKey } from "../keys/master-key.ts";
import { parsePreset } from "../policy/store.ts";
import type { Db } from "../storage/db.ts";
import { NotFoundError, UserError } from "../users/service.ts";
import { type AppEnv, jsonError, readJsonObject } from "./context.ts";

export interface SessionRoutesOptions {
	runtime: AgentRuntime;
	models: ModelConfig;
	masterKey: MasterKey;
	cluster: Cluster;
	groups: TaskGroups;
}

const THINKING = ["off", "minimal", "low", "medium", "high", "max"];

function parseModel(raw: unknown): ModelRef {
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o.provider !== "string" || typeof o.modelId !== "string") {
		throw new UserError("model must be { provider, modelId }");
	}
	if (o.thinkingLevel !== undefined && !THINKING.includes(o.thinkingLevel as string)) {
		throw new UserError(`thinkingLevel must be one of ${THINKING.join(", ")}`);
	}
	return {
		provider: o.provider,
		modelId: o.modelId,
		...(o.thinkingLevel ? { thinkingLevel: o.thinkingLevel as ModelRef["thinkingLevel"] } : {}),
	};
}

/** Sessions (chat with the agent) and model configuration; doc/agent-runtime.md. Expects requireUser. */
export function sessionRoutes(db: Db, options: SessionRoutesOptions) {
	const { runtime, models } = options;
	const app = new Hono<AppEnv>();

	app.onError((err, c) => {
		if (err instanceof NotFoundError) return jsonError(c, 404, err.message);
		if (err instanceof UserError) return jsonError(c, 400, err.message);
		throw err;
	});

	const admin = (c: Context<AppEnv>) => c.get("user").kind === "admin";

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
		const model = body?.model === null ? null : parseModel(body?.model);
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

	// ---- sessions: the owner, users it is shared with (view / chat), and administrators (look, do not drive) ----

	type Visible = { session: SessionView; access: SessionAccess };

	/** The session and what the caller may do with it; undefined when they cannot see it. */
	const visible = async (c: Context<AppEnv>, id: string): Promise<Visible | undefined> => {
		const access = await sessionAccess(db, c.get("user"), id);
		if (!access) return undefined;
		const session = await runtime.getSession(id);
		return session ? { session, access } : undefined;
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
		const shared =
			user.kind === "admin" ? new Map<string, SessionShareAccess>() : await sharedSessionAccess(db, user.userId);
		return views.map((v) => ({
			...v,
			access:
				v.ownerUserId === user.userId
					? ("owner" as const)
					: user.kind === "admin"
						? ("admin" as const)
						: (shared.get(v.id) ?? ("view" as const)),
			ownerUsername: names.get(v.ownerUserId) ?? null,
		}));
	};

	app.get("/sessions", async (c) => c.json({ sessions: await decorate(c, await runtime.listSessions(c.get("user"))) }));

	app.post("/sessions", async (c) => {
		const body = (await readJsonObject(c)) ?? {};
		// Quotas manage subagents; a root session has none (D76).
		if (body.quota !== undefined) return jsonError(c, 400, "a root session has no quota");
		const session = await runtime.createSession(c.get("user"), {
			model: parseModel(body.model),
			preset: parsePreset(body.preset ?? "ask"),
			...(typeof body.title === "string" ? { title: body.title } : {}),
		});
		return c.json({ session: (await decorate(c, [session]))[0] }, 201);
	});

	app.get("/sessions/:id", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		const canShare = v.access === "owner" || c.get("user").kind === "admin";
		return c.json({
			session: (await decorate(c, [v.session]))[0],
			...(canShare ? { shares: await listSessionShares(db, v.session.id) } : {}),
		});
	});

	app.get("/sessions/:id/shares", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (v.access !== "owner" && c.get("user").kind !== "admin") return jsonError(c, 403, "the owner only");
		return c.json({ shares: await listSessionShares(db, v.session.id) });
	});

	app.put("/sessions/:id/shares", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (v.access !== "owner" && c.get("user").kind !== "admin") return jsonError(c, 403, "the owner only");
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
		if (v.access !== "owner" && c.get("user").kind !== "admin") return jsonError(c, 403, "the owner only");
		const share = (await listSessionShares(db, v.session.id)).find((s) => s.id === c.req.param("shareId"));
		await unshareSession(db, v.session.id, c.req.param("shareId"));
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
		if (v.access !== "owner") return jsonError(c, 403, "the owner only");
		const s = v.session;
		const body = (await readJsonObject(c)) ?? {};
		const preset = body.preset === undefined ? undefined : parsePreset(body.preset);
		const session = await runtime.configure(s.id, {
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(body.model !== undefined ? { model: parseModel(body.model) } : {}),
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
		if (v.access !== "owner" && v.access !== "chat") return jsonError(c, 403, "chat access is required");
		const body = await readJsonObject(c);
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		const requestId = typeof body?.requestId === "string" && body.requestId ? body.requestId.slice(0, 200) : undefined;
		if (!text) return jsonError(c, 400, "text is required");
		if (!requestId) return jsonError(c, 400, "requestId is required");
		const submissionId = await runtime.submit(v.session.id, c.get("user"), text, requestId);
		return c.json({ submissionId }, 202);
	});

	app.post("/sessions/:id/abort", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		if (v.access !== "owner" && v.access !== "chat") return jsonError(c, 403, "chat access is required");
		await runtime.abort(v.session.id, c.get("user"));
		return c.json({ ok: true });
	});

	/** Server-sent events: `snapshot` first, then `events` batches as the session changes. */
	app.get("/sessions/:id/events", async (c) => {
		const v = await visible(c, c.req.param("id"));
		if (!v) return jsonError(c, 404, "no such session");
		return streamSSE(c, async (stream) => {
			const abort = new AbortController();
			stream.onAbort(() => abort.abort());
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
				await stream.sleep(15_000);
				if (!abort.signal.aborted) await stream.writeSSE({ event: "ping", data: "" });
			}
			await stop();
		});
	});

	return app;
}

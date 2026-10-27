import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { parseBudget } from "../agent/budget.ts";
import {
	builtinProviderIds,
	type CompatibleModel,
	deleteModelProvider,
	listModelProviders,
	type ModelConfig,
	type ModelRef,
	saveModelProvider,
} from "../agent/models.ts";
import type { AgentRuntime, SessionView } from "../agent/runtime.ts";
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

	// ---- sessions: the owner (and administrators) use them; sharing comes later ----

	const visible = async (c: Context<AppEnv>, id: string): Promise<SessionView | undefined> => {
		const s = await runtime.getSession(id);
		const user = c.get("user");
		return s && (s.ownerUserId === user.userId || user.kind === "admin") ? s : undefined;
	};
	/** Changes: only the owner; a session acts for its owner, an administrator looking in does not drive it. */
	const owned = async (c: Context<AppEnv>, id: string): Promise<SessionView | undefined> => {
		const s = await runtime.getSession(id);
		return s && s.ownerUserId === c.get("user").userId ? s : undefined;
	};

	app.get("/sessions", async (c) => c.json({ sessions: await runtime.listSessions(c.get("user")) }));

	app.post("/sessions", async (c) => {
		const body = (await readJsonObject(c)) ?? {};
		const session = await runtime.createSession(c.get("user"), {
			model: parseModel(body.model),
			preset: parsePreset(body.preset ?? "ask"),
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(body.budget !== undefined ? { budget: parseBudget(body.budget) } : {}),
		});
		return c.json({ session }, 201);
	});

	app.get("/sessions/:id", async (c) => {
		const s = await visible(c, c.req.param("id"));
		return s ? c.json({ session: s }) : jsonError(c, 404, "no such session");
	});

	app.patch("/sessions/:id", async (c) => {
		const s = await owned(c, c.req.param("id"));
		if (!s) return jsonError(c, 404, "no such session");
		const body = (await readJsonObject(c)) ?? {};
		const preset = body.preset === undefined ? undefined : parsePreset(body.preset);
		const session = await runtime.configure(s.id, {
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(body.model !== undefined ? { model: parseModel(body.model) } : {}),
			...(preset ? { preset } : {}),
			...(body.budget !== undefined ? { budget: parseBudget(body.budget) } : {}),
		});
		if (body.budget !== undefined) {
			void c.get("audit").record({
				actor: userActor(c.get("user")),
				action: "rules.changed",
				target: { type: "session", id: s.id },
				detail: { budget: body.budget },
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
		return c.json({ session });
	});

	/** `{ text, requestId }`: requestId makes a retried send land once. */
	app.post("/sessions/:id/messages", async (c) => {
		const s = await owned(c, c.req.param("id"));
		if (!s) return jsonError(c, 404, "no such session");
		const body = await readJsonObject(c);
		const text = typeof body?.text === "string" ? body.text.trim() : "";
		const requestId = typeof body?.requestId === "string" && body.requestId ? body.requestId.slice(0, 200) : undefined;
		if (!text) return jsonError(c, 400, "text is required");
		if (!requestId) return jsonError(c, 400, "requestId is required");
		const submissionId = await runtime.submit(s.id, c.get("user"), text, requestId);
		return c.json({ submissionId }, 202);
	});

	app.post("/sessions/:id/abort", async (c) => {
		const s = await owned(c, c.req.param("id"));
		if (!s) return jsonError(c, 404, "no such session");
		await runtime.abort(s.id);
		return c.json({ ok: true });
	});

	/** Server-sent events: `snapshot` first, then `events` batches as the session changes. */
	app.get("/sessions/:id/events", async (c) => {
		const s = await visible(c, c.req.param("id"));
		if (!s) return jsonError(c, 404, "no such session");
		return streamSSE(c, async (stream) => {
			const abort = new AbortController();
			stream.onAbort(() => abort.abort());
			let queue = Promise.resolve();
			const stop = await runtime.watch(
				s.id,
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

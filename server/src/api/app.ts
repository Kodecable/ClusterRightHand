import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { sql } from "kysely";
import type { ModelConfig } from "../agent/models.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Audit } from "../audit/audit.ts";
import { TaskGroups } from "../cluster/task-groups.ts";
import type { WebauthnConfig } from "../config.ts";
import type { MasterKey } from "../keys/master-key.ts";
import { mcpRoutes } from "../mcp/mcp.ts";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Db } from "../storage/db.ts";
import { apiTokenRoutes } from "./api-token-routes.ts";
import { approvalRoutes } from "./approval-routes.ts";
import { auditRoutes } from "./audit-routes.ts";
import { type AuthRoutesOptions, authRoutes } from "./auth-routes.ts";
import { authorizationRoutes } from "./authorization-routes.ts";
import { DEFAULT_BODY_LIMIT, jsonBodyLimit, takesLargeBody } from "./body-limit.ts";
import type { AppEnv } from "./context.ts";
import { credentialRoutes } from "./credential-routes.ts";
import { RequestDrain } from "./drain.ts";
import { apiErrorHandler } from "./errors.ts";
import { csrfGuard, requireUser } from "./middleware.ts";
import { modelPresetRoutes } from "./model-preset-routes.ts";
import { modelProviderRoutes } from "./model-provider-routes.ts";
import { nodeAccessRoutes } from "./node-access-routes.ts";
import { nodeGroupRoutes } from "./node-group-routes.ts";
import { nodeRoutes } from "./node-routes.ts";
import { privilegeRoutes } from "./privilege-routes.ts";
import { scheduleRoutes } from "./schedule-routes.ts";
import { SessionStreams, sessionEventRoutes } from "./session-events-routes.ts";
import { refuseWhenClosing, sessionRoutes } from "./session-routes.ts";
import { sshRoutes } from "./ssh-routes.ts";
import { taskRoutes } from "./task-routes.ts";
import { userRoutes } from "./user-routes.ts";

export interface AppOptions extends AuthRoutesOptions {
	/** Embedded in enrollment tokens so crha can pin crhs's identity key. */
	serverFingerprint?: string;
	/** crhs's Noise static public key, served to `crha enroll`. */
	serverPublicKey?: Uint8Array;
	/** crhs's authorization signing key, for the crhs trust entry and its snippet (doc/design/privilege.md "Server-side authorization"). */
	authorizationKey?: AuthorizationSigningKey;
	/** Needed for SSH credentials and nodes. */
	masterKey?: MasterKey;
	/** `[webauthn]` from crhs.toml; unset means Passkey registration follows the request's Origin. */
	webauthn?: WebauthnConfig;
	/** Warn when a node's clock differs by more than this; 0 disables (doc/design/privilege.md "Clock"). */
	clockWarnMs?: number;
	/** Directory of the built WebUI; served for every path outside /api, /agent and /mcp. */
	webRoot?: string;
	/** The audit log; one is created when omitted. */
	audit?: Audit;
	/** The agent runtime and its models; without them there are no sessions. */
	agent?: { runtime: AgentRuntime; models: ModelConfig };
	/** The scheduler that fires and submits scheduled runs (doc/design/scheduling.md); with it come the schedule routes. */
	scheduler?: Scheduler;
	/** Request tracking for shutdown; `main.ts` begins it when a signal arrives (a private one is made when omitted). */
	drain?: RequestDrain;
}

export function createApp(db: Db, options: AppOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const audit = options.audit ?? new Audit(db);
	const drain = options.drain ?? new RequestDrain();
	// Built once so the password routes reject the waiting work of revoked tokens through the same task groups.
	const cluster = options.cluster;
	const taskGroups = cluster ? (options.taskGroups ?? new TaskGroups(db, cluster, { audit })) : undefined;
	/**
	 * Filled in with the SSE routes below, which are built after the auth routes: logout and a password change
	 * end the affected streams immediately, and the streams' own ping check is only the fallback.
	 */
	let revalidateWebSessions: ((userId: string) => Promise<void>) | undefined;
	const onWebSessionsRevoked = (userId: string): Promise<void> | void => revalidateWebSessions?.(userId);

	// One error handler for every route (see errors.ts), so each route group keeps only its own routes.
	app.onError(apiErrorHandler());

	// First, so that a request arriving during shutdown is refused before it can authenticate or query the
	// database; requests already being handled are counted until they settle.
	app.use("*", drain.middleware());

	// Every route starts with the default limit, so no handler parses an unbounded body. The task input
	// routes and /mcp set their own, larger limit before their handlers (body-limit.ts).
	const defaultBodyLimit = jsonBodyLimit(DEFAULT_BODY_LIMIT);
	app.use("*", (c, next) => (takesLargeBody(c.req.path) ? next() : defaultBodyLimit(c, next)));

	app.use("/api/*", csrfGuard);
	app.use("/api/*", async (c, next) => {
		c.set("audit", audit);
		await next();
	});

	app.get("/api/health", async (c) => {
		await sql`select 1`.execute(db);
		return c.json({ status: "ok" });
	});

	// Public: crha fetches this during enrollment and checks it against the token's fingerprint.
	app.get("/agent/identity", (c) => {
		if (!options.serverPublicKey) return c.json({ error: "not configured" }, 503);
		return c.json({
			publicKey: Buffer.from(options.serverPublicKey).toString("base64"),
			fingerprint: options.serverFingerprint,
		});
	});

	app.route(
		"/api/auth",
		authRoutes(db, {
			...options,
			...(taskGroups ? { taskGroups } : {}),
			revalidateWebSessions: onWebSessionsRevoked,
		}),
	);

	app.use("/api/*", requireUser(db));
	app.route(
		"/api",
		userRoutes(db, {
			...(options.agent ? { sessions: options.agent.runtime.sessionList } : {}),
			...(cluster ? { cluster } : {}),
			...(taskGroups ? { taskGroups } : {}),
			revalidateWebSessions: onWebSessionsRevoked,
		}),
	);
	app.route("/api", nodeRoutes(db, options));
	app.route("/api", nodeGroupRoutes(db));
	app.route("/api", nodeAccessRoutes(db));
	app.route("/api", privilegeRoutes({ authorizationKey: options.authorizationKey }));
	app.route("/api", credentialRoutes(db, { webauthn: options.webauthn }));
	app.route("/api", authorizationRoutes(db, { cluster }));
	if (options.masterKey) app.route("/api", sshRoutes(db, options.masterKey));
	if (cluster && taskGroups) {
		app.route("/api", taskRoutes(db, cluster, taskGroups));
		app.route("/api", apiTokenRoutes(db, cluster, taskGroups, audit));
		app.route("/api", approvalRoutes(db, cluster, taskGroups, audit));
		app.route("/api", auditRoutes(db));
		if (options.agent && options.masterKey) {
			const { runtime, models } = options.agent;
			// The session and model routes reach the agent runtime: during shutdown they answer with the shutdown
			// rather than with the closed Harness's exception (main.ts). No other route group uses the runtime.
			const sessions = new Hono<AppEnv>();
			sessions.onError(apiErrorHandler({ closing: () => options.agent?.runtime.closing === true }));
			sessions.use("/sessions", refuseWhenClosing(runtime));
			sessions.use("/sessions/*", refuseWhenClosing(runtime));
			sessions.route("/", modelProviderRoutes(db, { models, masterKey: options.masterKey }));
			sessions.route("/", modelPresetRoutes({ runtime, models }));
			const streams = new SessionStreams(db, runtime, drain);
			revalidateWebSessions = async (userId) => {
				await streams.revalidateWebSessions(userId);
				await runtime.sessionList.revalidateWebSessions(userId);
			};
			// The event streams first: `GET /sessions/stream` must not be taken for `GET /sessions/:id`.
			sessions.route("/", sessionEventRoutes(db, { runtime, streams, drain }));
			sessions.route(
				"/",
				sessionRoutes(db, {
					runtime,
					cluster,
					taskGroups,
					streams,
					...(options.scheduler ? { scheduler: options.scheduler } : {}),
				}),
			);
			app.route("/api", sessions);
		}
		if (options.agent && options.scheduler) {
			app.route(
				"/api",
				scheduleRoutes(db, {
					scheduler: options.scheduler,
					models: options.agent.models,
					cluster,
					taskGroups,
				}),
			);
		}
		// Bearer-token authenticated, outside /api's cookie sessions and CSRF guard.
		app.route("/", mcpRoutes(db, { cluster, taskGroups, audit }));
	}

	if (options.webRoot) {
		const root = options.webRoot;
		const isApi = (path: string) => path.startsWith("/api/") || path.startsWith("/agent") || path === "/mcp";
		app.use("/*", async (c, next) => (isApi(c.req.path) ? next() : serveStatic({ root })(c, next)));
		// Client-side routes: anything else gets the app shell.
		app.get("*", async (c, next) =>
			isApi(c.req.path) ? c.json({ error: "not found" }, 404) : serveStatic({ root, path: "index.html" })(c, next),
		);
	}

	return app;
}

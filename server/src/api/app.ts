import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { sql } from "kysely";
import type { ModelConfig } from "../agent/models.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Audit } from "../audit/audit.ts";
import type { Cluster } from "../cluster/cluster.ts";
import { TaskGroups } from "../cluster/task-groups.ts";
import type { WebauthnConfig } from "../config.ts";
import type { MasterKey } from "../keys/master-key.ts";
import { mcpRoutes } from "../mcp/mcp.ts";
import type { AuthorizationSigningKey } from "../privilege/key.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Db } from "../storage/db.ts";
import { type AuthRoutesOptions, authRoutes } from "./auth-routes.ts";
import { authorizationRoutes } from "./authorization-routes.ts";
import type { AppEnv } from "./context.ts";
import { credentialRoutes } from "./credential-routes.ts";
import { RequestDrain } from "./drain.ts";
import { apiErrorHandler } from "./errors.ts";
import { csrfGuard, requireUser } from "./middleware.ts";
import { nodeAccessRoutes } from "./node-access-routes.ts";
import { nodeGroupRoutes } from "./node-group-routes.ts";
import { nodeRoutes } from "./node-routes.ts";
import { policyRoutes } from "./policy-routes.ts";
import { privilegeRoutes } from "./privilege-routes.ts";
import { scheduleRoutes } from "./schedule-routes.ts";
import { sessionRoutes } from "./session-routes.ts";
import { sshRoutes } from "./ssh-routes.ts";
import { taskRoutes } from "./task-routes.ts";
import { userRoutes } from "./user-routes.ts";

export interface AppOptions extends AuthRoutesOptions {
	/** Embedded in enrollment tokens so crha can pin crhs's identity key. */
	serverFingerprint?: string;
	/** crhs's Noise static public key, served to `crha enroll`. */
	serverPublicKey?: Uint8Array;
	cluster?: Cluster;
	taskGroups?: TaskGroups;
	/** crhs's authorization signing key, for the crhs trust entry and its snippet (doc/privilege.md#crhs-侧). */
	authorizationKey?: AuthorizationSigningKey;
	/** Needed for SSH credentials and nodes. */
	masterKey?: MasterKey;
	/** `[webauthn]` from crhs.toml; unset means Passkey registration follows the request's Origin. */
	webauthn?: WebauthnConfig;
	/** Warn when a node's clock differs by more than this; 0 disables (doc/privilege.md#时钟). */
	clockWarnMs?: number;
	/** Directory of the built WebUI; served for every path outside /api, /agent and /mcp. */
	webRoot?: string;
	/** The audit log; one is created when omitted. */
	audit?: Audit;
	/** The agent runtime and its models; without them there are no sessions. */
	agent?: { runtime: AgentRuntime; models: ModelConfig };
	/** The scheduler that fires and submits scheduled runs (doc/scheduling.md); with it come the schedule routes. */
	scheduler?: Scheduler;
	/** Request tracking for shutdown; `main.ts` begins it when a signal arrives (a private one is made when omitted). */
	drain?: RequestDrain;
}

export function createApp(db: Db, options: AppOptions = {}): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	const audit = options.audit ?? new Audit(db);
	const drain = options.drain ?? new RequestDrain();

	// One error handler for every route (see errors.ts), so each route group keeps only its own routes.
	app.onError(apiErrorHandler());

	// First, so that a request arriving during shutdown is refused before it can authenticate or query the
	// database; requests already being handled are counted until they settle.
	app.use("*", drain.middleware());

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

	app.route("/api/auth", authRoutes(db, options));

	app.use("/api/*", requireUser(db));
	app.route("/api", userRoutes(db, { ...(options.agent ? { sessions: options.agent.runtime.sessionList } : {}) }));
	app.route("/api", nodeRoutes(db, options));
	app.route("/api", nodeGroupRoutes(db));
	app.route("/api", nodeAccessRoutes(db));
	app.route("/api", privilegeRoutes({ authorizationKey: options.authorizationKey }));
	app.route("/api", credentialRoutes(db, { webauthn: options.webauthn }));
	app.route("/api", authorizationRoutes(db, { cluster: options.cluster }));
	if (options.masterKey) app.route("/api", sshRoutes(db, options.masterKey));
	if (options.cluster) {
		const taskGroups = options.taskGroups ?? new TaskGroups(db, options.cluster, { audit });
		app.route("/api", taskRoutes(db, options.cluster, taskGroups));
		app.route("/api", policyRoutes(db, options.cluster, taskGroups, audit));
		if (options.agent && options.masterKey) {
			// The session routes reach the agent runtime: during shutdown they answer with the shutdown rather
			// than with the closed Harness's exception (main.ts). No other route group uses the runtime.
			const sessions = new Hono<AppEnv>();
			sessions.onError(apiErrorHandler({ closing: () => options.agent?.runtime.closing === true }));
			sessions.route(
				"/",
				sessionRoutes(db, {
					...options.agent,
					masterKey: options.masterKey,
					cluster: options.cluster,
					taskGroups,
					drain,
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
					cluster: options.cluster,
					taskGroups,
				}),
			);
		}
		// Bearer-token authenticated, outside /api's cookie sessions and CSRF guard.
		app.route("/", mcpRoutes(db, { cluster: options.cluster, taskGroups, audit }));
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

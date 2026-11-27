import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HealthResponseSchema } from "@crh/api/schemas";
import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import { ModelCatalogue, type ModelConfig } from "../agent/models.ts";
import type { AgentRuntime } from "../agent/runtime.ts";
import { Audit } from "../audit/audit.ts";
import type { ChannelManager } from "../channels/manager.ts";
import type { CrhaReleases } from "../cluster/crha-release.ts";
import { TaskGroups } from "../cluster/task-groups.ts";
import type { WebauthnConfig } from "../config.ts";
import { configureBuiltinExtensions } from "../extensions/builtin.ts";
import { CallRunner } from "../extensions/call-runner.ts";
import type { McpConnections } from "../extensions/connections.ts";
import { createJobs, type Jobs } from "../jobs/jobs.ts";
import type { MasterKey } from "../keys/master-key.ts";
import type { LibraryBackend } from "../library/backend.ts";
import type { ImageCache } from "../library/image-cache.ts";
import { mcpRoutes } from "../mcp/mcp.ts";
import type { LatestMetrics } from "../metrics/collector.ts";
import type { MetricsStore } from "../metrics/store.ts";
import { type AuthorizationSigningKey, AuthorizationSigningKeyStore } from "../privilege/key.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { Db } from "../storage/db.ts";
import type { TerminalAttachments } from "../terminals/attach.ts";
import type { TerminalService } from "../terminals/registry.ts";
import { execJobRenderers } from "../tools/job-renderers.ts";
import { DEFAULT_BODY_LIMIT, jsonBodyLimit, takesLargeBody } from "../util/body-limit.ts";
import { apiTokenRoutes } from "./api-token-routes.ts";
import { approvalRoutes } from "./approval-routes.ts";
import { auditRoutes } from "./audit-routes.ts";
import { type AuthRoutesOptions, authRoutes } from "./auth-routes.ts";
import { authorizationRoutes } from "./authorization-routes.ts";
import { channelRoutes } from "./channel-routes.ts";
import type { AppEnv } from "./context.ts";
import { RequestDrain } from "./drain.ts";
import { apiErrorHandler } from "./errors.ts";
import { extensionRoutes } from "./extension-routes.ts";
import { jobRoutes } from "./job-routes.ts";
import { libraryRoutes } from "./library-routes.ts";
import { csrfGuard, requireUser } from "./middleware.ts";
import { modelPresetRoutes } from "./model-preset-routes.ts";
import { modelProviderRoutes } from "./model-provider-routes.ts";
import { nodeAccessRoutes } from "./node-access-routes.ts";
import { nodeGroupRoutes } from "./node-group-routes.ts";
import { nodeRoutes } from "./node-routes.ts";
import { apiDocument, defineRoute, json } from "./openapi.ts";
import { privilegeRoutes } from "./privilege-routes.ts";
import { scheduleRoutes } from "./schedule-routes.ts";
import { SessionStreams, sessionEventRoutes } from "./session-events-routes.ts";
import { refuseWhenClosing, sessionRoutes } from "./session-routes.ts";
import { settingsRoutes } from "./settings-routes.ts";
import { signingCredentialRoutes } from "./signing-credential-routes.ts";
import { sshRoutes } from "./ssh-routes.ts";
import { taskRoutes } from "./task-routes.ts";
import { terminalRoutes } from "./terminal-routes.ts";
import { userRoutes } from "./user-routes.ts";
import { userSettingsRoutes } from "./user-settings-routes.ts";

/**
 * The WebUI document's policy: the bundle and its fetches are same-origin. `script-src` allows the inline
 * scripts of index.html by their hash (the theme bootstrap) and cap's WebAssembly; `worker-src blob:` its
 * proof-of-work worker; `img-src data: blob:` image previews and the bundled math styles; and
 * `style-src 'unsafe-inline'` the style attributes React writes.
 */
export function webUiCsp(indexHtml: string): string {
	const hashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
		(match) =>
			`'sha256-${createHash("sha256")
				.update(match[1] ?? "")
				.digest("base64")}'`,
	);
	return [
		"default-src 'self'",
		"base-uri 'self'",
		"object-src 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
		"connect-src 'self'",
		"img-src 'self' data: blob:",
		"font-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		["script-src 'self'", ...hashes, "'wasm-unsafe-eval'"].join(" "),
		"worker-src 'self' blob:",
	].join("; ");
}

/** Headers for the WebUI document; API responses and file downloads keep their own. */
function setWebUiHeaders(c: Context, csp: string): void {
	c.header("Content-Security-Policy", csp);
	c.header("X-Frame-Options", "DENY");
	c.header("Referrer-Policy", "same-origin");
}

const healthRoute = defineRoute({
	method: "get",
	path: "/api/health",
	tags: ["Health"],
	summary: "Whether crhs is up: the database answered",
	agent: "allow",
	responses: { 200: { description: "The database answered", ...json(HealthResponseSchema) } },
});

/**
 * Every crawler is refused: crhs is an operations console, not a public site. Served whether or not a
 * WebUI build is configured (doc/design/webui.md).
 */
const robotsRoute = defineRoute({
	method: "get",
	path: "/robots.txt",
	tags: ["WebUI"],
	summary: "Search engines must not index or follow the console",
	agent: "allow",
	responses: {
		200: {
			description: "A robots.txt that disallows every crawler",
			content: { "text/plain": { schema: z.string() } },
		},
	},
});

const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

export interface AppOptions extends AuthRoutesOptions {
	/** Embedded in enrollment tokens so crha can pin crhs's identity key. */
	serverFingerprint?: string;
	/** crhs's Noise static public key, served to `crha enroll`. */
	serverPublicKey?: Uint8Array;
	/** crhs's authorization signing keys, for the crhs trust entries and their snippet (doc/design/privilege.md "Authorization signing key"). */
	signingKeys?: AuthorizationSigningKeyStore;
	/** A single signing key for callers that do not manage a set; ignored when `signingKeys` is given. */
	authorizationKey?: AuthorizationSigningKey;
	/** Needed for SSH credentials and nodes. */
	masterKey?: MasterKey;
	/** The library object store; without it library metadata still works and file routes answer 400. */
	libraryBackend?: LibraryBackend;
	/** The image cache behind `view_image`; the tool reports that it is not configured without one. */
	imageCache?: ImageCache;
	/** The MCP client connections behind external tools (doc/design/extensions.md). */
	mcp?: McpConnections;
	/** Chat channels (doc/design/channels.md); without one the channel routes are absent. */
	channels?: ChannelManager;
	/** `[webauthn]` fallback for tests; production passes `settings`. */
	webauthn?: WebauthnConfig;
	/** Clock-warning fallback for tests; production passes `settings` (doc/design/privilege.md "Clock"). */
	clockWarnMs?: number;
	/** Directory of the built WebUI; served for every path outside /api, /agent and /mcp. */
	webRoot?: string;
	/** `public_url` fallback for tests; production passes `settings`. */
	publicUrl?: string | null;
	/** The audit log; one is created when omitted. */
	audit?: Audit;
	/** The agent runtime and its models; without them there are no sessions. */
	agent?: { runtime: AgentRuntime; models: ModelConfig };
	/** The models.dev catalogue cache behind custom-provider discovery; without one an offline-only catalogue is used. */
	modelCatalogue?: ModelCatalogue;
	/** The crha release cache behind node upgrades (doc/design/distribution.md); without it upgrades answer 503. */
	crhaReleases?: CrhaReleases;
	/** The scheduler that fires and submits scheduled runs (doc/design/scheduling.md); with it come the schedule routes. */
	scheduler?: Scheduler;
	/** The terminal subsystem behind the Terminals page and the agent tools (doc/design/pty.md). */
	terminals?: TerminalService;
	/** The browser attachments of that subsystem; revocation and role changes end them too. */
	terminalAttachments?: TerminalAttachments;
	/** The host metrics store behind the node metrics API (doc/design/metrics.md). */
	metricsStore?: MetricsStore;
	/** Alias of `metricsStore` for callers that already name the store `metrics`, as `main.ts` does. */
	metrics?: MetricsStore;
	/** The collector's latest samples, behind the node list's CPU and memory figures. */
	metricsCollector?: {
		latest(nodeId: string): LatestMetrics | undefined;
		/** Why sampling is failing, for the online node's metrics warning (doc/design/metrics.md "Collection"). */
		metricsFailure?(nodeId: string): { reason: string; since: string } | undefined;
		/** The filesystem report order of the latest sample, for the Metrics summary (doc/design/metrics.md "Storage"). */
		diskOrder?(nodeId: string): string[] | undefined;
	};
	/** The job service shared with the agent runtime; one is made when a Cluster is present. */
	jobs?: Jobs;
	/** The crhs-owned extension calls the job service and MCP share; one is made when omitted. */
	callRunner?: CallRunner;
	/** Request tracking for shutdown; `main.ts` begins it when a signal arrives (a private one is made when omitted). */
	drain?: RequestDrain;
}

export function createApp(db: Db, options: AppOptions = {}): OpenAPIHono<AppEnv> {
	// OpenAPIHono collects the definitions of the route groups built with defineRoute (openapi.ts).
	const app = new OpenAPIHono<AppEnv>();
	const audit = options.audit ?? new Audit(db);
	const drain = options.drain ?? new RequestDrain();
	// The live key set: a caller may supply a single key, and an empty set has no crhs trust entry to show.
	const signingKeys =
		options.signingKeys ??
		(options.authorizationKey ? AuthorizationSigningKeyStore.fromKey(options.authorizationKey) : undefined);
	// Built once so the password routes reject the waiting work of revoked tokens through the same task groups.
	const cluster = options.cluster;
	const taskGroups = cluster ? (options.taskGroups ?? new TaskGroups(db, cluster, { audit })) : undefined;
	// The runner is one per process in production; a test app without one gets its own, shared with the job
	// service it builds so a call started over MCP and its job follow the same in-flight request.
	const callRunner = options.callRunner ?? options.jobs?.callRunner ?? new CallRunner();
	// The job tools are shared by agent sessions and MCP; the app makes one when the runtime did not pass its own.
	const jobs =
		options.jobs ??
		(cluster && taskGroups
			? createJobs({
					db,
					cluster,
					taskGroups,
					execRenderers: execJobRenderers,
					callRunner,
					...(audit ? { audit } : {}),
				})
			: undefined);
	/**
	 * Filled in with the SSE routes below, which are built after the auth routes: logout and a password change
	 * end the affected streams immediately, and the streams' own ping check is only the fallback.
	 */
	let revalidateStreams: ((userId: string) => Promise<void>) | undefined;
	const onWebSessionsRevoked = async (userId: string): Promise<void> => {
		await options.terminalAttachments?.revalidateWebSessions(userId);
		await revalidateStreams?.(userId);
	};

	// One error handler for every route (see errors.ts), so each route group keeps only its own routes.
	app.onError(apiErrorHandler());

	// Nothing this process serves is for a search engine: every response, including errors, static files
	// and the WebUI shell, says so (doc/design/webui.md). Registered before the drain
	// middleware, so a refusal during shutdown carries it too.
	app.use("*", async (c, next) => {
		c.header("X-Robots-Tag", "noindex, nofollow");
		await next();
	});

	// Before everything else but the header above, so that a request arriving during shutdown is refused before it can authenticate or query the
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

	app.openapi(healthRoute, async (c) => {
		await sql`select 1`.execute(db);
		return c.json({ status: "ok" as const }, 200);
	});

	// Public and before the WebUI's static handler and SPA fallback, so this is never index.html.
	app.openapi(robotsRoute, (c) => c.text(ROBOTS_TXT, 200, { "Content-Type": "text/plain; charset=utf-8" }));

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
			...(options.channels ? { channels: options.channels } : {}),
			...(options.terminals ? { terminals: options.terminals } : {}),
			revalidateWebSessions: onWebSessionsRevoked,
		}),
	);

	app.use("/api/*", requireUser(db));
	// Presence for chat notifications: a WebUI request in the last ten minutes counts as online. Internal
	// `api_request` calls carry an actor and are not the WebUI.
	app.use("/api/*", async (c, next) => {
		const user = c.get("user");
		if (user && user.actor === undefined) options.channels?.presence.touch(user.userId);
		await next();
	});
	app.route(
		"/api",
		userRoutes(db, {
			...(options.settings ? { settings: options.settings } : {}),
			...(options.agent ? { sessions: options.agent.runtime.sessionList } : {}),
			...(cluster ? { cluster } : {}),
			...(taskGroups ? { taskGroups } : {}),
			...(options.channels ? { channels: options.channels } : {}),
			...(options.terminals ? { terminals: options.terminals } : {}),
			...(options.terminalAttachments ? { terminalAttachments: options.terminalAttachments } : {}),
			revalidateWebSessions: onWebSessionsRevoked,
		}),
	);
	app.route("/api", userSettingsRoutes(db, options.agent ? { models: options.agent.models } : {}));
	app.route(
		"/api",
		settingsRoutes(db, {
			...(options.settings ? { settings: options.settings } : {}),
			onChanged: (changes) => {
				if (changes.some((change) => change.key.startsWith("pty."))) {
					options.terminals?.applySettings();
					options.agent?.runtime.setTerminalToolsEnabled(options.terminals?.enabled === true);
				}
			},
		}),
	);
	app.route("/api", libraryRoutes(db, options.libraryBackend ? { backend: options.libraryBackend } : {}));
	app.route("/api", nodeRoutes(db, { ...options, signingKeys, ...(taskGroups ? { taskGroups } : {}) }));
	app.route("/api", nodeGroupRoutes(db));
	app.route("/api", nodeAccessRoutes(db));
	app.route("/api", privilegeRoutes({ db, ...(signingKeys ? { signingKeys } : {}) }));
	app.route(
		"/api",
		signingCredentialRoutes(db, {
			...(options.webauthn ? { webauthn: options.webauthn } : {}),
			...(options.settings ? { settings: options.settings } : {}),
			...(options.serverFingerprint ? { serverIdentity: options.serverFingerprint } : {}),
		}),
	);
	app.route("/api", authorizationRoutes(db, { cluster, ...(taskGroups ? { taskGroups } : {}) }));
	if (options.masterKey) app.route("/api", sshRoutes(db, options.masterKey, cluster));
	if (options.masterKey && options.mcp) {
		app.route(
			"/api",
			extensionRoutes(db, {
				masterKey: options.masterKey,
				connections: options.mcp,
				onExtensionChanged: (row, tools) => {
					options.agent?.runtime.installExtensionTools(row, tools);
				},
				onExtensionDeleted: (name) => {
					options.agent?.runtime.removeExtension(name);
				},
			}),
		);
	}
	if (options.masterKey && options.channels) {
		app.route("/api", channelRoutes({ db, channels: options.channels, audit }));
	}
	if (cluster && taskGroups) {
		app.route("/api", taskRoutes(db, cluster, taskGroups));
		app.route("/api", apiTokenRoutes(db, cluster, taskGroups, audit));
		app.route("/api", approvalRoutes(db, cluster, taskGroups, audit, options.terminals));
		// The job API shares the runtime's job service, so a decision or cancel projects the same rows the tools do.
		if (jobs) app.route("/api", jobRoutes(db, { jobs }));
		app.route("/api", auditRoutes(db));
		if (options.agent && options.masterKey) {
			const { runtime, models } = options.agent;
			// Discovery reads models.dev; without a state directory the built-in offline catalogue is the only source.
			const catalogue = options.modelCatalogue ?? new ModelCatalogue({ download: false });
			// The session and model routes reach the agent runtime: during shutdown they answer with the shutdown
			// rather than with the closed Harness's exception (main.ts). No other route group uses the runtime.
			// OpenAPIHono, so the model route definitions are passed on to the API document when this group is mounted.
			const sessions = new OpenAPIHono<AppEnv>();
			sessions.onError(apiErrorHandler({ closing: () => options.agent?.runtime.closing === true }));
			sessions.use("/sessions", refuseWhenClosing(runtime));
			sessions.use("/sessions/*", refuseWhenClosing(runtime));
			sessions.route(
				"/",
				modelProviderRoutes(db, {
					models,
					masterKey: options.masterKey,
					catalogue,
					sessionModel: () => runtime.modelPresets.get("session").model,
				}),
			);
			sessions.route("/", modelPresetRoutes({ runtime, models }));
			const streams = new SessionStreams(db, runtime, drain);
			revalidateStreams = async (userId) => {
				await streams.revalidateWebSessions(userId);
				await runtime.sessionList.revalidateWebSessions(userId);
			};
			// The event streams first: `GET /sessions/stream` must not be taken for `GET /sessions/:id`.
			sessions.route(
				"/",
				sessionEventRoutes(db, {
					runtime,
					streams,
					drain,
					...(options.channels ? { presence: options.channels.presence } : {}),
					// A job's projection change travels on its session's stream as `job.changed` (doc/design/jobs.md "API").
					...(jobs ? { jobs } : {}),
					// The todo list is session state; `todo_write` publishes each replacement as `todo.changed`.
					todoLists: runtime.todoLists,
				}),
			);
			sessions.route(
				"/",
				sessionRoutes(db, {
					runtime,
					cluster,
					taskGroups,
					streams,
					...(options.scheduler ? { scheduler: options.scheduler } : {}),
					...(options.settings ? { settings: options.settings } : {}),
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
		app.route(
			"/",
			mcpRoutes(db, {
				cluster,
				taskGroups,
				audit,
				callRunner,
				...(jobs ? { jobs } : {}),
				...(options.imageCache ? { imageCache: options.imageCache } : {}),
				...(options.settings ? { settings: options.settings } : {}),
				...(options.publicUrl !== undefined ? { publicUrl: options.publicUrl } : {}),
			}),
		);
	}

	// The terminal routes serve only their user and administrators; they are mounted whether or not this
	// process also has an agent runtime.
	if (options.terminals) app.route("/api", terminalRoutes({ terminals: options.terminals, db }));

	if (options.webRoot) {
		const root = options.webRoot;
		// The shell is fixed for the process's lifetime, so its inline scripts are hashed once.
		let indexHtml = "";
		try {
			indexHtml = readFileSync(join(root, "index.html"), "utf8");
		} catch {
			// No built shell: nothing inline to allow.
		}
		const csp = webUiCsp(indexHtml);
		const isApi = (path: string) => path.startsWith("/api/") || path.startsWith("/agent") || path === "/mcp";
		app.use("/*", async (c, next) => {
			if (isApi(c.req.path)) return next();
			setWebUiHeaders(c, csp);
			return serveStatic({ root })(c, next);
		});
		// Client-side routes: anything else gets the app shell.
		app.get("*", async (c, next) => {
			if (isApi(c.req.path)) return c.json({ error: "not found" }, 404);
			setWebUiHeaders(c, csp);
			return serveStatic({ root, path: "index.html" })(c, next);
		});
	}

	// The built-in extensions read this app's routes: `crhs-docs` renders the API reference from the same
	// document, and `api_request` runs through this router as the session owner (doc/design/extensions.md
	// "Built-in extensions"). All routes are mounted at this point.
	configureBuiltinExtensions({
		api: {
			document: apiDocument(app),
			request: async (request, identity) => app.request(request, undefined, { crhInternal: identity }),
		},
	});

	return app;
}

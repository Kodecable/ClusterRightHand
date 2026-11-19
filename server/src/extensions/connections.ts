import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionStatus, ExtensionToolAnnotations } from "@crh/api";
import {
	Client,
	type FetchLike,
	ProtocolError,
	StreamableHTTPClientTransport,
	type Tool,
} from "@modelcontextprotocol/client";
import type { MasterKey } from "../keys/master-key.ts";
import type { Db } from "../storage/db.ts";
import { errorText } from "../util/errors.ts";
import { redactUrlsInText } from "../util/url.ts";
import { cutUtf8 } from "../util/utf8.ts";
import { CRH_VERSION } from "../version.ts";
import type { BuiltinExtensionProvider } from "./builtin.ts";
import { ExtensionCallLostError, type ExtensionTool, ExtensionToolError, ExtensionUnavailableError } from "./model.ts";
import {
	type ExtensionRow,
	extensionCacheOf,
	getExtensionRow,
	listExtensionRows,
	mcpExtensionConfig,
	readBuiltinConfig,
	revisedTools,
	saveExtensionCache,
} from "./store.ts";

/**
 * The MCP client connections behind extensions (doc/design/extensions.md "MCP connections"). crhs connects to a
 * server only when it needs it: a call, a first listing, an administrator, or the daily refresh. A connection
 * left idle is closed. What the server reported — its tools, its `instructions` and `serverInfo.description` —
 * is cached on the extension row, so search, the tool guide and the direct tools work without a connection
 * and survive a restart.
 *
 * Every tool carries the rev at which its definition last changed. A call is judged on the definitions a fresh
 * connection lists, and a call that waited for approval runs only if its tool's rev is unchanged.
 *
 * The module holds no pi types: the agent layer installs the direct tools when a list changes.
 */

/** A connection with no call for this long is closed; the next call connects again. */
export const MCP_IDLE_DISCONNECT_MS = 10 * 60_000;
/** Every MCP extension's tool list and description are refreshed this often, connected or not. */
export const MCP_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
/** An extension never listed yet is refreshed within this window of startup or of being configured. */
const FIRST_REFRESH_WINDOW_MS = 60_000;
/** The scheduled refresh is spread over this fraction of the interval, so servers are not all hit at once. */
const REFRESH_JITTER = 0.1;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/**
 * A call on an unreachable server gives up at once when a connection attempt failed within this window
 * (doc/design/extensions.md "MCP connections"): one hung or looping model cannot hammer the server.
 */
const FAILED_ATTEMPT_WINDOW_MS = 10_000;

/** The CRH identity sent to a server for one call; the identity headers are not authentication. */
export interface McpIdentity {
	username: string;
	sessionId: string;
}

export interface McpConnectionOptions {
	db: Db;
	masterKey: MasterKey;
	/** In-process fetch for tests; the global fetch otherwise. */
	fetch?: FetchLike;
	/** Called when a server's tool list changes, so the agent layer can reinstall its direct tools. */
	onToolsChanged?: (server: ExtensionRow, tools: readonly ExtensionTool[]) => void;
	/** Called when a server's state changes, for diagnostics. */
	onStatusChanged?: (name: string, status: ExtensionStatus) => void;
	/** How long an idle connection stays open; tests shorten it. */
	idleDisconnectMs?: number;
	/** How often the tool list is refreshed; tests shorten it. */
	refreshIntervalMs?: number;
	/** How long a connection attempt may take (10 s by default); tests shorten it. */
	connectTimeoutMs?: number;
	/** The clock; tests inject one. */
	now?: () => number;
	/** Random numbers for the refresh spread; tests make it fixed. */
	random?: () => number;
	/** Version reported to the server. */
	version?: string;
}

interface ServerState {
	name: string;
	row: ExtensionRow | null;
	/** The state of the last refresh, or `connecting` while one runs. */
	status: ExtensionStatus["state"];
	lastError: string | null;
	refreshedAt: string | null;
	nextRefreshAt: string | null;
	tools: ExtensionTool[];
	toolsRev: number;
	instructions: string | null;
	serverDescription: string | null;
	/** Whether the cache was loaded from the row. */
	seeded: boolean;
	client?: Client;
	transport?: StreamableHTTPClientTransport;
	/** The connected server announces `tools/list_changed`, so a live list stays current without asking. */
	listChanged: boolean;
	connecting?: Promise<void>;
	refreshTimer?: ReturnType<typeof setTimeout>;
	idleTimer?: ReturnType<typeof setTimeout>;
	/** Calls in flight on the connection; an idle close waits for them. */
	inFlight: number;
	/** When the last connection attempt failed; a call in the next window tries no further. */
	lastFailureAt: number | null;
}

/** The longest server `instructions` crhs keeps and shows the model; the rest is cut. */
const MAX_SERVER_INSTRUCTIONS_BYTES = 8 * 1024;
/** The longest `serverInfo.description` crhs keeps: it is a one-line summary. */
const MAX_SERVER_DESCRIPTION_BYTES = 1024;

/** A text the server reports about itself: trimmed, empty as none, cut at a UTF-8 boundary. */
function serverText(text: string | undefined, maxBytes: number): string | null {
	const trimmed = text?.trim() ?? "";
	return trimmed === "" ? null : cutUtf8(trimmed, maxBytes);
}

function toTool(tool: Tool): ExtensionTool {
	const annotations = (tool.annotations ?? null) as ExtensionToolAnnotations | null;
	return {
		name: tool.name,
		title: tool.title ?? annotations?.title ?? null,
		description: tool.description ?? null,
		inputSchema:
			typeof tool.inputSchema === "object" && tool.inputSchema !== null
				? (tool.inputSchema as Record<string, unknown>)
				: { type: "object", properties: {} },
		annotations,
	};
}

export class McpConnections {
	readonly #options: McpConnectionOptions;
	readonly #states = new Map<string, ServerState>();
	readonly #identity = new AsyncLocalStorage<McpIdentity>();
	readonly #fetch: FetchLike;
	#closing = false;

	constructor(options: McpConnectionOptions) {
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
	}

	/** Lets the agent layer install the direct tools after the connections exist (runtime startup). */
	setToolsChangedHandler(handler: (server: ExtensionRow, tools: readonly ExtensionTool[]) => void): void {
		this.#options.onToolsChanged = handler;
	}

	/** Loads every MCP extension's cache and schedules its refresh (startup). Nothing connects here. */
	async start(): Promise<void> {
		for (const row of await listExtensionRows(this.#options.db)) {
			if (row.kind === "mcp") this.seed(row);
		}
	}

	#state(name: string): ServerState {
		let state = this.#states.get(name);
		if (!state) {
			state = {
				name,
				row: null,
				status: "unknown",
				lastError: null,
				refreshedAt: null,
				nextRefreshAt: null,
				tools: [],
				toolsRev: 0,
				instructions: null,
				serverDescription: null,
				seeded: false,
				listChanged: false,
				inFlight: 0,
				lastFailureAt: null,
			};
			this.#states.set(name, state);
		}
		return state;
	}

	/**
	 * Takes a stored row's cache when this process has nothing newer: at startup, and whenever an adapter is
	 * built for a row another path wrote. Schedules the row's refresh if none is scheduled.
	 */
	seed(row: ExtensionRow): void {
		if (row.kind !== "mcp" || this.#closing) return;
		const state = this.#state(row.name);
		state.row = row;
		if (!state.seeded || row.tools_rev > state.toolsRev) {
			const cache = extensionCacheOf(row);
			state.tools = cache.tools;
			state.toolsRev = cache.toolsRev;
			state.instructions = cache.instructions;
			state.serverDescription = cache.description;
			state.refreshedAt = cache.refreshedAt;
			state.lastError = cache.refreshError;
			if (state.status !== "connecting") {
				state.status = cache.refreshError !== null ? "unavailable" : cache.refreshedAt !== null ? "ready" : "unknown";
			}
			state.seeded = true;
		}
		if (state.refreshTimer === undefined && row.enabled === 1) this.#scheduleRefresh(state);
	}

	#statusOf(state: ServerState): ExtensionStatus {
		return {
			state: state.status,
			lastError: state.lastError,
			nextAttemptAt: state.nextRefreshAt,
			toolCount: state.tools.length,
			connected: state.client !== undefined,
			refreshedAt: state.refreshedAt,
		};
	}

	/** The state last known in this process; a server never listed reports `unknown`. */
	status(name: string): ExtensionStatus {
		return this.#statusOf(this.#state(name));
	}

	statuses(names: readonly string[]): Map<string, ExtensionStatus> {
		return new Map(names.map((name) => [name, this.status(name)]));
	}

	/** The tool list last listed for a server; empty before the first successful listing. */
	tools(name: string): readonly ExtensionTool[] {
		return this.#state(name).tools;
	}

	/** The server's own `instructions` at its last listing. */
	instructions(name: string): string | null {
		return this.#state(name).instructions;
	}

	/** The server's `serverInfo.description` at its last listing. */
	serverDescription(name: string): string | null {
		return this.#state(name).serverDescription;
	}

	/** The tool as last listed, if it is still listed. */
	tool(name: string, toolName: string): ExtensionTool | undefined {
		return this.#states.get(name)?.tools.find((candidate) => candidate.name === toolName);
	}

	#notifyStatus(state: ServerState): void {
		this.#options.onStatusChanged?.(state.name, this.#statusOf(state));
	}

	#now(): number {
		return this.#options.now ? this.#options.now() : Date.now();
	}

	#refreshInterval(): number {
		return this.#options.refreshIntervalMs ?? MCP_REFRESH_INTERVAL_MS;
	}

	#clearRefresh(state: ServerState): void {
		if (state.refreshTimer !== undefined) clearTimeout(state.refreshTimer);
		state.refreshTimer = undefined;
		state.nextRefreshAt = null;
	}

	#clearIdle(state: ServerState): void {
		if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
		state.idleTimer = undefined;
	}

	/**
	 * The next refresh: one interval after the last successful one, spread by the jitter; a server never
	 * listed is refreshed soon, within the first-refresh window.
	 */
	#scheduleRefresh(state: ServerState, options: { afterAttempt?: boolean } = {}): void {
		this.#clearRefresh(state);
		if (this.#closing) return;
		const interval = this.#refreshInterval();
		const random = this.#options.random ?? Math.random;
		let delay: number;
		if (state.refreshedAt === null && !options.afterAttempt) {
			// Never listed: soon, spread only over the first-refresh window.
			delay = random() * Math.min(FIRST_REFRESH_WINDOW_MS, interval);
		} else {
			const base = options.afterAttempt
				? interval
				: Math.max(0, Date.parse(state.refreshedAt ?? "") + interval - this.#now());
			delay = base + random() * interval * REFRESH_JITTER;
		}
		state.nextRefreshAt = new Date(this.#now() + delay).toISOString();
		state.refreshTimer = setTimeout(() => {
			state.refreshTimer = undefined;
			state.nextRefreshAt = null;
			void this.#scheduledRefresh(state);
		}, delay);
		// A pending refresh must not keep the process alive by itself.
		state.refreshTimer.unref?.();
	}

	/** The daily refresh: list the tools on the live connection, or connect for it and close again. */
	async #scheduledRefresh(state: ServerState): Promise<void> {
		try {
			if (state.client) {
				await this.#listTools(state, state.client);
			} else {
				await this.#connect(state);
				// The refresh opened this connection, so close it again unless a call is using it now.
				if (state.inFlight === 0) await this.#disconnect(state);
			}
		} catch {
			// The state carries the error; the cache stays for search and the tool guide.
		}
		if (state.row?.enabled === 1 && this.#states.get(state.name) === state) {
			this.#scheduleRefresh(state, { afterAttempt: true });
		}
	}

	/** Closes the connection after the idle time; calls in flight keep it open until they end. */
	#touch(state: ServerState): void {
		this.#clearIdle(state);
		if (this.#closing || !state.client) return;
		state.idleTimer = setTimeout(() => {
			state.idleTimer = undefined;
			if (state.inFlight > 0) return;
			void this.#disconnect(state);
		}, this.#options.idleDisconnectMs ?? MCP_IDLE_DISCONNECT_MS);
		state.idleTimer.unref?.();
	}

	/** Closes the client; the cache and the refresh schedule stay. */
	async #disconnect(state: ServerState): Promise<void> {
		this.#clearIdle(state);
		const client = state.client;
		state.client = undefined;
		state.transport = undefined;
		if (client) await client.close().catch(() => undefined);
		this.#notifyStatus(state);
	}

	/**
	 * Drops a server's connection: deleted by an administrator (the whole state goes), or reset for a
	 * configuration change, where the cached tool list stays so a direct tool is not lost until the next
	 * listing, and a refresh is scheduled soon to check the new configuration.
	 */
	async invalidate(name: string, options: { keepTools?: boolean } = {}): Promise<void> {
		const state = this.#states.get(name);
		if (!state) return;
		this.#clearRefresh(state);
		const connecting = state.connecting;
		if (connecting) await connecting.catch(() => undefined);
		await this.#disconnect(state);
		this.#clearRefresh(state);
		if (!options.keepTools) {
			this.#states.delete(name);
			return;
		}
		state.lastFailureAt = null;
		state.lastError = null;
		state.status = "unknown";
		state.refreshedAt = null;
		const row = await getExtensionRow(this.#options.db, name);
		if (row) {
			state.row = row;
			if (row.kind === "mcp" && row.enabled === 1) this.#scheduleRefresh(state);
		}
		this.#notifyStatus(state);
	}

	/**
	 * Connects one server now, sharing an attempt in flight, and lists its tools. Throws on failure; the state
	 * and the row then hold the error, and the cache stays.
	 */
	async #connect(state: ServerState, options: { timeoutMs?: number } = {}): Promise<void> {
		if (this.#closing) throw new ExtensionUnavailableError("crhs is shutting down");
		if (state.connecting) return state.connecting;
		const name = state.name;
		const attempt = (async () => {
			state.status = "connecting";
			this.#notifyStatus(state);
			// Close a previous client first: reconnect and an edited configuration both start from scratch.
			const old = state.client;
			state.client = undefined;
			state.transport = undefined;
			if (old) await old.close().catch(() => undefined);
			const row = await getExtensionRow(this.#options.db, name);
			if (row?.kind !== "mcp" || row.enabled !== 1) {
				// A disabled or deleted extension must not be contacted, even when a call or a stale timer asks.
				this.#clearRefresh(state);
				const message = row?.kind === "mcp" ? "the extension is disabled" : "no such MCP extension";
				state.status = "unavailable";
				state.lastError = message;
				this.#notifyStatus(state);
				throw new ExtensionUnavailableError(message);
			}
			state.row = row;
			if (!state.seeded) this.seed(row);
			const config = await mcpExtensionConfig(this.#options.db, this.#options.masterKey, row);
			const identity = this.#identity;
			const baseFetch = this.#fetch;
			const fetchWithIdentity: FetchLike = async (input, init) => {
				const who = identity.getStore();
				if (!who) return baseFetch(input, init);
				const headers = new Headers(init?.headers);
				if (config.identityHeaders.username) headers.set(config.identityHeaders.username, who.username);
				if (config.identityHeaders.session) headers.set(config.identityHeaders.session, who.sessionId);
				return baseFetch(input, { ...init, headers });
			};
			const client = new Client(
				{ name: "clusterrighthand", version: this.#options.version ?? CRH_VERSION },
				{
					listChanged: {
						tools: {
							onChanged: (error, tools) => {
								if (error || !tools || state.client !== client) return;
								this.#setTools(state, client, tools).catch((err: unknown) => {
									console.error(`mcp: refreshing the tool list of ${name} failed:`, redactUrlsInText(errorText(err)));
								});
							},
						},
					},
				},
			);
			const transport = new StreamableHTTPClientTransport(new URL(config.url), {
				requestInit: { headers: config.headers },
				fetch: fetchWithIdentity,
				// crhs owns reconnecting: the transport must not retry the event stream behind its back.
				reconnectionOptions: {
					initialReconnectionDelay: 1000,
					maxReconnectionDelay: 300_000,
					reconnectionDelayGrowFactor: 2,
					maxRetries: 0,
				},
			});
			state.client = client;
			state.transport = transport;
			try {
				await this.#connectClient(
					name,
					client,
					transport,
					options.timeoutMs ?? this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
				);
				state.listChanged = client.getServerCapabilities()?.tools?.listChanged === true;
				// The server's own text reaches the tool guide: an empty one counts as none, and both are bounded.
				state.instructions = serverText(client.getInstructions(), MAX_SERVER_INSTRUCTIONS_BYTES);
				state.serverDescription = serverText(client.getServerVersion()?.description, MAX_SERVER_DESCRIPTION_BYTES);
				await this.#listTools(state, client);
				state.lastFailureAt = null;
				// A connection that drops is closed here; the next use connects again. The cache stays valid.
				transport.onclose = () => {
					if (this.#closing || state.client !== client) return;
					state.client = undefined;
					state.transport = undefined;
					this.#clearIdle(state);
					this.#notifyStatus(state);
				};
				this.#touch(state);
			} catch (err) {
				if (state.client === client) {
					state.client = undefined;
					state.transport = undefined;
				}
				await client.close().catch(() => undefined);
				state.lastFailureAt = this.#now();
				// A token in the endpoint's query must not reach the status page or a tool result.
				const message = redactUrlsInText(errorText(err));
				await this.#recordFailure(state, message);
				throw new ExtensionUnavailableError(message);
			}
		})();
		state.connecting = attempt;
		try {
			await attempt;
		} finally {
			if (state.connecting === attempt) state.connecting = undefined;
		}
	}

	/** Connects with a bound: a server that accepts the request but never completes cannot hold a call. */
	async #connectClient(
		name: string,
		client: Client,
		transport: StreamableHTTPClientTransport,
		timeoutMs: number,
	): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				client.connect(transport),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new ExtensionUnavailableError(`connecting to ${name} timed out after ${timeoutMs / 1000} s`)),
						timeoutMs,
					);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/** Lists the tools on a live client and records them; a failure is recorded and rethrown. */
	async #listTools(state: ServerState, client: Client): Promise<void> {
		let listed: Tool[];
		try {
			listed = (await client.listTools({}, { cacheMode: "refresh" })).tools;
		} catch (err) {
			const message = redactUrlsInText(errorText(err));
			await this.#recordFailure(state, message);
			throw new ExtensionUnavailableError(message);
		}
		await this.#setTools(state, client, listed);
	}

	/**
	 * Records a listing: per-tool revs, the server's description, the refresh time, in memory and on the row.
	 * The agent layer reinstalls direct tools only when the list changed.
	 */
	async #setTools(state: ServerState, client: Client, listed: readonly Tool[]): Promise<void> {
		// A listing from a client that was replaced meanwhile is stale.
		if (state.client !== client) return;
		const revised = revisedTools(state.tools, state.toolsRev, listed.map(toTool));
		const changed = revised.toolsRev !== state.toolsRev;
		state.tools = revised.tools;
		state.toolsRev = revised.toolsRev;
		state.refreshedAt = new Date(this.#now()).toISOString();
		state.status = "ready";
		state.lastError = null;
		await saveExtensionCache(this.#options.db, state.name, {
			instructions: state.instructions,
			description: state.serverDescription,
			tools: state.tools,
			toolsRev: state.toolsRev,
			refreshedAt: state.refreshedAt,
			refreshError: null,
		});
		// Read the row again: the administrator may have flipped a flag since this connection was opened.
		state.row = (await getExtensionRow(this.#options.db, state.name)) ?? state.row;
		if (changed && state.row) this.#options.onToolsChanged?.(state.row, state.tools);
		this.#notifyStatus(state);
	}

	/** A failed connection or listing: the error goes to the state and the row, the cache stays. */
	async #recordFailure(state: ServerState, message: string): Promise<void> {
		state.status = "unavailable";
		state.lastError = message;
		this.#notifyStatus(state);
		const orgId = state.row?.org_id;
		if (orgId === undefined) return;
		await this.#options.db
			.updateTable("extensions")
			.set({ refresh_error: message })
			.where("org_id", "=", orgId)
			.where("name", "=", state.name)
			.where("kind", "=", "mcp")
			.execute()
			.catch(() => undefined);
	}

	/**
	 * Makes sure a tool list is known before a search. A server with a cached list is not contacted: search
	 * works on the cache, and the daily refresh and calls keep it current.
	 */
	async ensureListed(name: string): Promise<void> {
		const state = this.#state(name);
		if (state.refreshedAt !== null || state.tools.length > 0) return;
		if (state.connecting) return state.connecting;
		if (state.lastFailureAt !== null && this.#now() - state.lastFailureAt < FAILED_ATTEMPT_WINDOW_MS) {
			throw new ExtensionUnavailableError(state.lastError ?? "the server is unavailable");
		}
		await this.#connect(state);
	}

	/**
	 * Gets a server ready for a call: connected, with a tool list as current as the server's: a fresh
	 * connection lists its tools, and a live one that does not announce list changes is asked again. A call
	 * right after a failed attempt fails at once instead of hammering the server.
	 */
	async prepareCall(name: string): Promise<void> {
		const state = this.#state(name);
		if (state.connecting) {
			await state.connecting;
			return;
		}
		if (state.client) {
			if (!state.listChanged) await this.#listTools(state, state.client);
			this.#touch(state);
			return;
		}
		if (state.lastFailureAt !== null && this.#now() - state.lastFailureAt < FAILED_ATTEMPT_WINDOW_MS) {
			throw new ExtensionUnavailableError(state.lastError ?? "the server is unavailable");
		}
		await this.#connect(state);
	}

	/** An administrator asked: connect now and reload the tools, even when connected. */
	async reconnect(name: string): Promise<ExtensionStatus> {
		const state = this.#state(name);
		const connecting = state.connecting;
		if (connecting) await connecting.catch(() => undefined);
		await this.#disconnect(state);
		state.lastFailureAt = null;
		try {
			await this.#connect(state);
		} catch {
			// The state carries the error.
		}
		return this.#statusOf(state);
	}

	/** Reloads the tool list now (the settings page's "view tools"). */
	async refreshTools(name: string): Promise<readonly ExtensionTool[]> {
		const state = this.#state(name);
		if (state.connecting) await state.connecting.catch(() => undefined);
		if (state.client) {
			await this.#listTools(state, state.client);
			this.#touch(state);
		} else {
			state.lastFailureAt = null;
			await this.#connect(state);
		}
		return state.tools;
	}

	/**
	 * Calls a tool with the per-server timeout on the connection `prepareCall` made. The identity headers
	 * carry the calling user and session. A timeout or an abort aborts the request, which the Streamable HTTP
	 * transport turns into an MCP cancellation; a connection failure after the request started has an unknown
	 * outcome.
	 */
	async callTool(
		name: string,
		toolName: string,
		args: Record<string, unknown>,
		options: { signal?: AbortSignal; identity?: McpIdentity; timeoutMs?: number } = {},
	): Promise<unknown> {
		const state = this.#state(name);
		if (!state.client) await this.prepareCall(name);
		const client = state.client;
		if (!client) throw new ExtensionUnavailableError(state.lastError ?? "the server is unavailable");
		state.inFlight += 1;
		this.#clearIdle(state);
		const timeoutMs = options.timeoutMs ?? state.row?.timeout_ms ?? 300_000;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		timer.unref?.();
		const onAbort = () => controller.abort();
		if (options.signal?.aborted) controller.abort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		const run = async (): Promise<unknown> => {
			try {
				return await client.callTool({ name: toolName, arguments: args }, { signal: controller.signal });
			} catch (err) {
				if (timedOut) throw new ExtensionCallLostError(`the call timed out after ${timeoutMs / 1000} s`);
				if (options.signal?.aborted) throw new ExtensionCallLostError("the call was aborted");
				if (err instanceof ProtocolError) throw new ExtensionToolError(errorText(err));
				// The request did not complete normally: its outcome is unknown, and the connection is no longer
				// trusted. The next call connects again.
				const message = redactUrlsInText(errorText(err));
				if (state.client === client) {
					const transport = state.transport;
					state.client = undefined;
					state.transport = undefined;
					void client.close().catch(() => {});
					void transport?.close().catch(() => {});
					state.lastFailureAt = this.#now();
					state.status = "unavailable";
					state.lastError = message;
					this.#notifyStatus(state);
				}
				throw new ExtensionCallLostError(message);
			} finally {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				state.inFlight -= 1;
				if (state.inFlight === 0) this.#touch(state);
			}
		};
		return options.identity ? this.#identity.run(options.identity, run) : run();
	}

	/**
	 * A built-in extension's settings for a call, secrets decrypted. It lives here because this object holds
	 * the database and the master key for every extension.
	 */
	async builtinConfig(
		name: string,
		provider: BuiltinExtensionProvider,
	): Promise<Record<string, string | number | boolean>> {
		// Read the row now, not the one the session saw: an approval may have waited while the settings changed.
		const row = await getExtensionRow(this.#options.db, name);
		if (row?.kind !== "builtin") throw new ExtensionUnavailableError(`no built-in extension named ${name}`);
		if (row.enabled !== 1) throw new ExtensionUnavailableError(`the extension ${name} is disabled`);
		return readBuiltinConfig(this.#options.db, this.#options.masterKey, row, provider);
	}

	/** Closes every connection and timer; a later call reports shutdown. */
	async close(): Promise<void> {
		this.#closing = true;
		for (const state of this.#states.values()) {
			this.#clearRefresh(state);
			const connecting = state.connecting;
			if (connecting) await connecting.catch(() => undefined);
			await this.#disconnect(state);
		}
		this.#states.clear();
	}
}
